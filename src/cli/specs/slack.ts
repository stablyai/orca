import type { CommandSpec } from '../discovery/command-spec'
import { CLI_GLOBAL_FLAGS as GLOBAL_FLAGS } from '../../shared/cli/cli-argument-boundary'

const AS_BOT =
  "Run it from a bot's chat or one of its automation runs; it acts as that bot's own Slack app, only where the bot already is. GitHub and Linear are your owner's: use `gh` and `orca linear`."
const PLACE =
  'A place or message is a ref from an earlier command (slack:T…:C…[:thread][:message]), a Slack link or a #name; output always shows the ref and a label. Quote #names in the shell.'
const TO_PERSON =
  "A person (@name, user:<id> or a ref from `orca slack find @name`) gets it in the bot's DM with them, opening one if needed; in more than one workspace, use the ref find --workspace prints."
const WOKEN = 'To answer the thread that woke you, use `orca bot reply`; a post there is refused.'
export const TEXT_FILE =
  'Pass multiline text as a file with --text-file <path> (- reads stdin), not a heredoc: heredocs can hang the shell when macOS pipe memory is low.'
const POSTED_REF =
  'Prints a ref for this post at once, before or after Slack sends it: `orca slack edit` or `delete` it, or post to it to answer in its thread, and each goes in order. Once sent, the ref acts on the message itself.'
export const SLACK_MENTION =
  "Mention a person with <@USERID> (`orca slack find @name` shows it); ping a channel with <!here>, <!channel> or <!everyone>, a user group with <!subteam^GROUPID>. A read shows mentions the same way, as `<@USERID|Name>` (`<@USERID>` with no name), `<!subteam^GROUPID|@team>` and `<#CHANNELID|name>`, so copying one pings (a channel's becomes a link); a read's `@here`, `@channel` or `@everyone` is plain words and pings no one."
export const SLACK_MARKDOWN =
  "Text is Markdown: bold is **text** (Slack's *text* comes out italic), and a mention inside `code` stays plain text."

export const SLACK_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['slack', 'find'],
    summary:
      'List Slack channels matching a name or link, best first, look a person up, or search Slack as the person asking',
    usage:
      'orca slack find <name|link|@person> [--workspace <ref>] [--json]  |  orca slack find --search "<words>" [--workspace <name|ref>] [--limit <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'query', 'workspace', 'search', 'limit'],
    positionalArgs: ['query'],
    notes: [
      AS_BOT,
      'Never picks one for you; pass the ref you mean to the next command.',
      '@name looks a person up in the workspace of the conversation you answer; elsewhere, or for another workspace, pass --workspace with a ref from `orca bot connectors`. Pass their ref to `orca slack post` or `attach` to DM them.',
      '--search takes words and searches the whole workspace, as the person this run answers: the workspace of the Slack conversation you answer, or the one --workspace names (as `orca bot connectors` shows it, or its ref), which is needed anywhere else. --limit applies only with --search, 20 by default and at most 50.'
    ]
  },
  {
    path: ['slack', 'check'],
    summary: 'Say whether this bot is in a Slack channel, and how it gets in',
    usage: 'orca slack check <place> [--join] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'ref', 'join'],
    positionalArgs: ['ref'],
    notes: [AS_BOT, PLACE, '--join joins a public channel; a private one needs an invite.']
  },
  {
    path: ['slack', 'read'],
    summary: 'Read recent messages in a Slack channel or thread, oldest first',
    usage:
      'orca slack read <place> [--limit <n>] [--before <ref>] [--download <file id> [--out <path>]] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'ref', 'limit', 'before', 'download', 'out'],
    positionalArgs: ['ref'],
    notes: [
      AS_BOT,
      PLACE,
      '--limit is 1 to 100 (default 20). When older messages remain, the output ends with the --before ref that reads them.',
      'A message lists its files by id; `read <message> --download <id>` saves one (up to 640 KB) to --out, or under its own name here (numbered when taken); open the path it prints.'
    ]
  },
  {
    path: ['slack', 'post'],
    summary: 'Post a message in a Slack channel, thread or DM as this bot',
    usage: 'orca slack post <place|@person> (<text> | --text-file <path|->) [--at <time>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'ref', 'text', 'text-file', 'at'],
    positionalArgs: ['ref', 'text'],
    notes: [
      AS_BOT,
      PLACE,
      TO_PERSON,
      `A message ref posts in its thread. ${WOKEN}`,
      POSTED_REF,
      '--at posts it later, by Slack itself: in a while (+30m, +2h, +3d) or at a time with its zone (2026-12-01T09:00:00-08:00), up to 120 days ahead. A scheduled post has no ref to edit until it posts.',
      TEXT_FILE,
      SLACK_MENTION,
      SLACK_MARKDOWN
    ]
  },
  {
    path: ['slack', 'attach'],
    summary: 'Attach a file in a Slack channel, thread or DM as this bot, with an optional comment',
    usage:
      'orca slack attach <place|@person> --file <path> [--text <comment> | --text-file <path|->] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'ref', 'file', 'text', 'text-file'],
    positionalArgs: ['ref'],
    notes: [
      AS_BOT,
      PLACE,
      TO_PERSON,
      'Any size Slack takes. To attach in the thread that woke you, use `orca bot reply --file`; an attach there is refused.'
    ]
  },
  {
    path: ['slack', 'react'],
    summary: 'Add or remove an emoji reaction on a Slack message as this bot',
    usage: 'orca slack react <message> <emoji> [--remove] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'ref', 'emoji', 'remove'],
    positionalArgs: ['ref', 'emoji'],
    notes: [
      AS_BOT,
      PLACE,
      'The emoji is a common one (👍 🎉) or its :shortcode:. Reacting twice, or removing one that is gone, is not an error. In the Slack thread that woke you, `orca bot reply --react` needs no ref; Orca manages 👀 and ✅ there, and a reaction that is your whole response ends with a final message of only NO_REPLY.'
    ]
  },
  {
    path: ['slack', 'pin'],
    summary: 'Pin a Slack message to its channel, or unpin it, as this bot',
    usage: 'orca slack pin <message> [--remove] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'ref', 'remove'],
    positionalArgs: ['ref'],
    notes: [
      AS_BOT,
      PLACE,
      'Pinning one already pinned, or unpinning one that is not, is not an error.'
    ]
  },
  {
    path: ['slack', 'canvas'],
    summary: 'Make a canvas in a Slack channel from Markdown, as this bot',
    usage: 'orca slack canvas <place> --title <title> (<markdown> | --text-file <path|->) [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'ref', 'title', 'text', 'text-file'],
    positionalArgs: ['ref', 'text'],
    notes: [
      AS_BOT,
      PLACE,
      'The canvas is added to the channel as a tab, and the answer gives its link. It takes headings to three levels, lists and checklists, tables, quotes and code blocks; a code block inside a list item or a table is refused.',
      TEXT_FILE
    ]
  },
  {
    path: ['slack', 'list'],
    summary: 'Make a Slack list of tasks and share it with a channel, as this bot',
    usage: 'orca slack list <place> --title <title> --item <text> [--item <text>]... [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'ref', 'title', 'item'],
    repeatableFlags: ['item'],
    positionalArgs: ['ref'],
    notes: [
      AS_BOT,
      PLACE,
      'Each --item is one task, in order (up to 50), with a checkbox, an assignee and a due date people fill in. The answer gives its link. Slack lists need a paid Slack plan.'
    ]
  },
  {
    path: ['slack', 'scheduled'],
    summary: 'See the posts this bot scheduled in a Slack channel, or cancel one',
    usage: 'orca slack scheduled <place> [--cancel <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'ref', 'cancel'],
    positionalArgs: ['ref'],
    notes: [
      AS_BOT,
      PLACE,
      'Lists what `orca slack post --at` scheduled there, each with the id --cancel takes. Slack cancels none in its last minute before posting.'
    ]
  },
  {
    path: ['slack', 'edit'],
    summary: "Replace the text of one of this bot's own Slack messages",
    usage: 'orca slack edit <message> (<text> | --text-file <path|->) [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'ref', 'text', 'text-file'],
    positionalArgs: ['ref', 'text'],
    notes: [
      AS_BOT,
      PLACE,
      "Only messages the bot posted itself; anyone else's is refused. `orca slack post` prints a ref for this post.",
      TEXT_FILE,
      SLACK_MENTION,
      SLACK_MARKDOWN
    ]
  },
  {
    path: ['slack', 'delete'],
    destructive: true,
    aliases: [['slack', 'rm']],
    summary: "Delete one of this bot's own Slack messages",
    usage: 'orca slack delete <message> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'ref'],
    positionalArgs: ['ref'],
    notes: [AS_BOT, PLACE, "Only messages the bot posted itself; anyone else's is refused."]
  }
]
