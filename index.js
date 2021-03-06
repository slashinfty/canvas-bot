// Load modules
const Discord = require('discord.js');
const Twitter = require('twitter');
const fetch = require('node-fetch');
const oauthSignature = require('oauth-signature');
const randomstring = require('randomstring');
const fs = require('fs');
const path = require('path');

// Load configuration
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json')));

// Set up Discord & Twitter
const discord = new Discord.Client();
discord.login(config.discord.token);
const twitter = new Twitter({
    "consumer_key": config.twitter.consumer_key,
    "consumer_secret": config.twitter.consumer_secret,
    "access_token_key": config.twitter.access_token_key,
    "access_token_secret": config.twitter.access_token_secret
});

// Global variables
let servers;
let announcements = {};
let assignments = {};
const canvasInit = {
    "method": "GET",
    "headers": {
        "Content-Type": "application/json+canvas-string-ids",
        "Accept": "application/json+canvas-string-ids",
        "Authorization": "Bearer " + config.canvas.token
    }
};
const twitterGetInit = {
    "method": "GET",
    "headers": {
        "content-Type": "application/json",
        "Authorization": "Bearer " + config.twitter.bearer_token
    }
}

// Sending a status/reply to Twitter
const sendTwitter = async (statusToTweet, replyTo = null) => {
    const params = replyTo === null ? {
        status: statusToTweet
    } : {
        status: statusToTweet,
        in_reply_to_status_id: replyTo
    };
    await twitter.post('statuses/update', params)
        .catch(err => console.error(err));
}

// Sending a message to Discord
const sendDiscord = async (embed, courseOrChannel, channel = false) => {
    if (channel) await courseOrChannel.send(embed);
    else {
        // Get all servers watching the course
        const receivingServers = servers.filter(s => s.course === courseOrChannel);
        // Send embed
        for (let i = 0; i < receivingServers.length; i++){
            const thisChannel = await discord.channels.fetch(receivingServers[i].channel);
            await thisChannel.send(embed);
        }
    }
}

// Convert HTML message to plain text
const extract = content => content.replace(/<[^>]+>/g, '');

// Update servers
const serverUpdate = () => {
    // Get file contents
    const file = path.join(__dirname, 'servers.json');
    const contents = fs.readFileSync(file);
    let serverObject = JSON.parse(contents);
    // Update with current servers and write
    serverObject.servers = servers;
    fs.writeFileSync(file, JSON.stringify(serverObject));
}

// Function to get recent announcement
const getAnnouncement = async courseId => {
    // Query Canvas for announcements
    const announcementsResponse = await fetch(config.canvas.domain + 'api/v1/announcements?context_codes[]=course_' + courseId, canvasInit);
    const announcementsArray = await announcementsResponse.json();
    // Find the most recent announcement that has been published
    const mostRecentAnnouncementObject = announcementsArray.find(ann => ann.published === true);
    // If there are no announcements, or there isn't a new one, return a blank object
    const mostRecentAnnouncement = mostRecentAnnouncementObject === undefined || announcements[courseId].find(ann => ann.id === mostRecentAnnouncementObject.id) !== undefined ? {} : {
        "id": mostRecentAnnouncementObject.id,
        "title": mostRecentAnnouncementObject.title,
        "date": new Date(mostRecentAnnouncementObject.posted_at).toISOString().replace(/T\S*/,''),
        "message": extract(mostRecentAnnouncementObject.message),
        "link": mostRecentAnnouncementObject.url
    }
    return mostRecentAnnouncement;
}

// Function to get recent assignments
const getAssignments = async (courseId, groupId) => {
    // Query Canvas for assignments
    const assignmentResponse = await fetch(config.canvas.domain + 'api/v1/courses/' + courseId + '/assignment_groups/' + groupId + '/assignments?bucket=upcoming&order_by=due_at', canvasInit);
    const assignmentArray = await assignmentResponse.json();
    let upcomingAssignments = [];
    const now = new Date(Date.now());
    for (let i = 0; i < assignmentArray.length; i++) {
        // Stop once we find an assignment that was due before now
        if (new Date(assignmentArray[i].due_at) - now <= 0) break;
        // If the assignment isn't unlocked, skip it
        if (new Date(assignmentArray[i].unlock_at) - now > 0) continue;
        // If this assignment isn't new, skip it
        if (assignments[courseId].homework.find(hw => hw.id === assignmentArray[i].id !== undefined) || assignments[courseId].tests.find(t => t.id === assignmentArray[i].id !== undefined)) continue;
        const nextAssignment = {
            "id": assignmentArray[i].id,
            "title": assignmentArray[i].name,
            "start_date": new Date(assignmentArray[i].unlock_at).toISOString().replace(/T\S*/,''),
            "due_date": new Date(assignmentArray[i].due_at).toISOString().replace(/T\S*/,''),
            "link": assignmentArray[i].html_url
        }
        upcomingAssignments.push(nextAssignment);
    }
    return upcomingAssignments.reverse();
}

// To run once Discord has connected
discord.once('ready', async () => {
    console.log('Canvas bot is online @ ' + new Date(Date.now()));
    // Set Discord status
    discord.user.setPresence({
        "activity": {
            "name": "@me help",
            "type": "LISTENING"
        },
        "status": "dnd"
    });

    // Load servers information
    const serverFile = path.join(__dirname, 'servers.json');
    // Create the file if it doesn't exist
    if (!fs.existsSync(serverFile)) {
        const newServerObject = {
            "servers": []
        };
        fs.writeFileSync(serverFile, JSON.stringify(newServerObject));
    }
    // Read the file contents
    const serverContents = fs.readFileSync(serverFile);

    // Set global variables
    servers = JSON.parse(serverContents).servers;
    for (let i = 0; i < config.canvas.courses.length; i++) {
        let course = config.canvas.courses[i];
        announcements[course.id] = [];
        const recentAnnouncement = await getAnnouncement(course.id);
        announcements[course.id].push(recentAnnouncement);
        assignments[course.id] = {
            "link": config.canvas.domain + "courses/" + course.id + "/assignments",
            "homework": [],
            "tests": []
        }
        assignments[course.id].homework = await getAssignments(course.id, course.homework);
        assignments[course.id].tests = await getAssignments(course.id, course.tests);
    }
});

// Listening for messages on Discord
discord.on('message', async message => {
    // User must mention the bot
    if (message.mentions.users.has(discord.user.id)) {
        // Help message
        // Requires user to include the word "help"
        if (message.content.search(/help/i) > -1) {
            message.reply('Need help? <https://mattbraddock.com/canvas-bot/help>');
            return;
        }

        // All following options require a course name being included
        // Determine the course
        let course = config.canvas.courses.find(c => message.content.search(new RegExp('(' + c.name + '|' + c.nick + ')', 'i')) > -1);
        // If no course specified, return a list of courses
        if (course === undefined) {
            let courseList = '';
            config.canvas.courses.forEach((c, i) => courseList += i === 0 ? c.name : ', ' + c.name);
            message.reply('Could not recognize the course name. Valid options are: ' + courseList);
            return;
        }

        // Adding/removing a channel to message
        // Requires user to be an administrator and include one of add/remove/delete
        if (message.member.hasPermission("ADMINISTRATOR")) {
            // Get mentioned channel, or current channel if none mentioned
            const channel = message.mentions.channels.size === 1 ? message.mentions.channels.first() : message.channel;
            // To check if we are monitoring this already
            const foundServer = servers.find(s => s.server === message.guild.id && s.channel === channel.id && s.course === course.id);
            // Check if we're adding or removing
            if (message.content.search(/add/i) > -1) {
                // If we're trying to add a course we're already monitoring
                if (foundServer !== undefined) {
                    message.reply('I am already monitoring ' + course.name + ' in ' + channel.name);
                    return;
                }
                const newServer = {
                    "server": message.guild.id,
                    "serverName": message.guild.name,
                    "channel": channel.id,
                    "channelName": channel.name,
                    "course": course.id,
                    "courseName": course.name
                }
                servers.push(newServer);
                message.reply('Now monitoring ' + course.name + ' in ' + channel.name);
                serverUpdate();
                return;
            } else if (message.content.search(/(remove|delete)/i) > -1) {
                // If we're trying to remove a course we're not already monitoring
                if (foundServer === undefined) {
                    message.reply('I am not currently monitoring ' + course.name + ' in ' + channel.name);
                    return;
                }
                servers.splice(servers.indexOf(foundServer), 1);
                message.reply('No longer monitoring ' + course.name + ' in ' + channel.name);
                serverUpdate();
                return;
            }
        }

        // Querying about an announcement or assignment
        // Requires users to include one of announcement/news/homework/hw/test/exam
        if (message.content.search(/(announcement|news)/i) > -1) {
            const thisAnnouncement = announcements[course.id][0];
            const announcementMessage = thisAnnouncement.message.length >= 1024 ? thisAnnouncement.message.substring(0, 1020) + '...' : thisAnnouncement.message;
            const announcementEmbed = new Discord.MessageEmbed()
                .setColor('#f24e4e')
                .setTitle(thisAnnouncement.title)
                .setURL(thisAnnouncement.link)
                .setAuthor("Mr. Braddock's Canvas Bot")
                .addField('Posted:', thisAnnouncement.date)
                .addField('Announcement:', announcementMessage)
                .setTimestamp();
            await sendDiscord(announcementEmbed, message.channel, true);
            return;
        } else if (message.content.search(/(homework|hw)/i) > -1) {
            const thisHomework = assignments[course.id].homework;
            let homeworkMessage = thisHomework.length > 0 ? '' : 'No Upcoming Homework';
            thisHomework.forEach((h, i) => {
                homeworkMessage += i === 0 ? '' : '\n';
                homeworkMessage += h.title + ' (Due Date: ' + h.due_date + ')';
            });
            const homeworkEmbed = new Discord.MessageEmbed()
                .setColor('#4c84ed')
                .setTitle('Upcoming Homework')
                .setURL(assignments[course.id].link)
                .setAuthor("Mr. Braddock's Canvas Bot")
                .addField('Assignments:', homeworkMessage)
                .setTimestamp();
            await sendDiscord(homeworkEmbed, message.channel, true);
            return;
        } else if (message.content.search(/(test|exam|quiz|tests|exams|quizzes)/i) > -1 ) {
            const thisTests = assignments[course.id].tests;
            let testMessage = thisTests.length > 0 ? '' : 'No Upcoming Tests';
            thisTests.forEach((t, i) => {
                testMessage += i === 0 ? '' : '\n';
                testMessage += t.title + ' (Date: ' + t.due_date + ')';
            });
            const testEmbed = new Discord.MessageEmbed()
                .setColor('#4eeb4b')
                .setTitle('Upcoming Assessments')
                .setURL(assignments[course.id].link)
                .setAuthor("Mr. Braddock's Canvas Bot")
                .addField('Assessments:', testMessage)
                .setTimestamp();
            await sendDiscord(testEmbed, message.channel, true);
            return;
        } else {
            message.reply("I could not recognize what you're looking for. Available options are: announcement, homework, tests");
            return;
        }
    }
});

// Remove servers if the bot is removed from the server
discord.on('guildDelete', guild => {
    const server = servers.filter(s => s.server === guild.id);
    server.forEach(s => servers.splice(servers.indexOf(s), 1));
    serverUpdate();
});

// Checks to run every 5 minutes
discord.setInterval(async () => {
    for (let i = 0; i < config.canvas.courses.length; i++) {
        const thisCourse = config.canvas.courses[i];

        // Check for new announcements
        const newAnnouncement = await getAnnouncement(thisCourse.id);
        if (Object.keys(newAnnouncement).length !== 0 && newAnnouncement.constructor === Object) {
            // Tweet announcement
            const announcementStatus = '[' + thisCourse.name + '] ' + newAnnouncement.title + ' ' + newAnnouncement.link;
            await sendTwitter(announcementStatus);
            // Post announcement in Discord
            const announcementMessage = newAnnouncement.message.length >= 1024 ? newAnnouncement.message.substring(0, 1020) + '...' : newAnnouncement.message;
            const announcementEmbed = new Discord.MessageEmbed()
                .setColor('#f24e4e')
                .setTitle(newAnnouncement.title)
                .setURL(newAnnouncement.link)
                .setAuthor("Mr. Braddock's Canvas Bot")
                .addField('Posted:', newAnnouncement.date)
                .addField('Announcement:', announcementMessage)
                .setTimestamp();
            await sendDiscord(announcementEmbed, thisCourse.id);
            announcements[thisCourse.id] = [newAnnouncement];
        }

        // Check for new homework
        const newHomework = await getAssignments(thisCourse.id, thisCourse.homework);
        for (let j = 0; j < newHomework.length; j++) {
            const homework = newHomework[j];
            // Tweet homework
            const homeworkStatus = '[' + thisCourse.name + '] ' + homework.title + ' (Due Date: ' + homework.due_date + ') ' + homework.link;
            await sendTwitter(homeworkStatus);
            // Post homework in Discord
            const homeworkEmbed = new Discord.MessageEmbed()
                .setColor('#4c84ed')
                .setTitle(homework.title)
                .setURL(homework.link)
                .setAuthor("Mr. Braddock's Canvas Bot")
                .addField('Start Date:', homework.start_date)
                .addField('Due Date:', homework.due_date)
                .setTimestamp();
            await sendDiscord(homeworkEmbed, thisCourse.id);
            assignments[thisCourse.id].homework.push(homework);
        }

        // Check for new tests
        const newTests = await getAssignments(thisCourse.id, thisCourse.tests);
        for (let j = 0; j < newTests.length; j++) {
            const test = newTests[j];
            // Tweet tests
            const testStatus = '[' + thisCourse.name + '] ' + test.title + ' (Date: ' + test.due_date + ') ' + test.link;
            await sendTwitter(testStatus);
            // Post tests in Discord
            const testEmbed = new Discord.MessageEmbed()
                .setColor('#4eeb4b')
                .setTitle(test.title)
                .setURL(test.link)
                .setAuthor("Mr. Braddock's Canvas Bot")
                .addField('Start Date:', test.start_date)
                .addField('Due Date:', test.due_date)
                .setTimestamp();
            await sendDiscord(testEmbed, thisCourse.id);
            assignments[thisCourse.id].tests.push(test);
        }
    }

    // Get recent mentions
    const recentMentionsResponse = await fetch("https://api.twitter.com/2/tweets/search/recent?query=%40" + config.twitter.handle + "&tweet.fields=created_at,in_reply_to_user_id&expansions=author_id", twitterGetInit);
    const recentMentionsObject = await recentMentionsResponse.json();
    const fiveMinutesAgo = new Date(Date.now() - 3e5);
    // Go through mentions and tweet replies
    if (recentMentionsObject.hasOwnProperty('data')) {
        for (let j = 0; j < recentMentionsObject.data.length; j++) {
            const thisTweet = recentMentionsObject.data[j];
            // Stop when a tweet is over 5 minutes old
            if (new Date(thisTweet.created_at) - fiveMinutesAgo <= 0) break;
            // If not a direct tag of the bot, skip
            // This helps ignore retweets
            if (thisTweet.in_reply_to_user_id !== config.twitter.user_id) continue;
            // Determine which class is mentioned
            let course = config.canvas.courses.find(c => thisTweet.text.search(new RegExp('(' + c.name + '|' + c.nick + ')', 'i')) > -1);
            // Determine if we're looking for an announcement or assignment
            let objectToTweet, missingItem;
            if (thisTweet.text.search(/(announcement|news)/i) > -1) {
                objectToTweet = announcements[course.id][0];
                missingItem = 'No recent announcement.';
            } else if (thisTweet.text.search(/(homework|hw)/i) > -1) {
                objectToTweet = assignments[course.id].homework.length === 0 ? {} : assignments[course.id].homework[0];
                missingItem = 'No upcoming homework.';
            } else if (thisTweet.text.search(/(test|exam|quiz|tests|exams|quizzes)/i) > -1) {
                objectToTweet = assignments[course.id].tests.length === 0 ? {} : assignments[course.id].tests[0];
                missingItem = 'No upcoming tests.';
            }
            // If announcement or assignment is not mentioned, skip
            if (objectToTweet === undefined) continue;
            // Constructing the reply and tweeting
            const date = thisTweet.text.search(/(homework|hw)/i) > -1 ? 'Due Date: ' + objectToTweet.due_date : thisTweet.text.search(/(announcement|news)/i) > -1 ? objectToTweet.date : 'Date: ' + objectToTweet.due_date;
            const sender = recentMentionsObject.includes.users.find(u => u.id === thisTweet.author_id).username;
            let tweetContent = '@' + sender + ' '; 
            tweetContent += (Object.keys(objectToTweet).length === 0 && objectToTweet.constructor === Object) ? missingItem : objectToTweet.title + ' (' + date + ') ' + objectToTweet.link;
            await sendTwitter(tweetContent, thisTweet.id);
        }
    }
}, 3e5);