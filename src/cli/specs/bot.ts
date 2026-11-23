import {
  CONNECTOR_REPLY_CHOICE_MAX_CHARS,
  CONNECTOR_REPLY_MAX_CHOICES,
  CONNECTOR_REPLY_MAX_FILES
} from '../../shared/connector-action-contract'
import type { CommandSpec } from '../discovery/command-spec'
import { CLI_GLOBAL_FLAGS as GLOBAL_FLAGS } from '../../shared/cli/cli-argument-boundary'
import { SLACK_MARKDOWN, SLACK_MENTION, TEXT_FILE } from './slack'

const BOT_NOTES = ['A bot lives on the computer that runs the command, in ~/.orca/bots/<name>.']

export const BOT_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['bot', 'create'],
    summary:
      'Propose a new bot to your owner as a card in your chat; it is created only when they accept',
    usage:
      'orca bot create --offer --name <name> --purpose <one sentence> [--template <id>] [--watches <text>] [--does <text>] [--reports <text>] [--worktree <selector>]... [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'name',
      'offer',
      'purpose',
      'template',
      'watches',
      'does',
      'reports',
      'worktree'
    ],
    repeatableFlags: ['worktree'],
    notes: [
      ...BOT_NOTES,
      "Run it from a bot's chat when your owner asks for a new bot, or work fits no bot `orca bot list` shows. Nothing is created until they press Create bot (or Edit it first); a Not now comes back as a message.",
      '--purpose becomes the first line of its SOUL.md, written before its first turn; it starts by reading and reporting only. --template takes a built-in template id (pr-review, release, support…; a wrong id lists them all) and fills --name, --purpose, --watches, --does and --reports when you leave them out.',
      "--worktree takes id:<id> or name:<workspace name>, as `orca worktree ps` shows them; the new bot's first turn takes each over. Repeat it for several."
    ]
  },
  {
    path: ['bot', 'list'],
    summary: 'List the bots on this computer, what each is for, and the address that reaches it',
    usage: 'orca bot list [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    notes: [
      ...BOT_NOTES,
      "What each is for is the first paragraph of its SOUL.md. `orca orchestration send --to bot:<name>` mails that bot's Chat."
    ]
  },
  {
    path: ['bot', 'chats'],
    summary:
      "List a bot's chats: each one's id, title, last activity, and what it was last asked and said",
    usage: 'orca bot chats [--bot <name>] [--all] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'bot', 'all'],
    notes: [
      ...BOT_NOTES,
      "Run from a bot's chat it lists that bot's own chats, this one marked; --bot lists another bot's. Each row starts with the chat's id, the only thing --chat takes; the title only helps match your owner's words.",
      'Earlier Home Chats, closed when a new one started, take no mail and are hidden; --all shows them too.',
      '`orca orchestration send --to bot:<name> --chat <id> --type question|handoff` mails that chat instead of the Home Chat, and its answer comes back to you the same way. Your own other chats take mail too, --chat new starts a new one titled from --subject, and with no --chat it lands in the Home Chat; only the chat you send from is refused.'
    ]
  },
  {
    path: ['bot', 'new-chat'],
    hidden: true,
    summary:
      'Start a new Home Chat: the bot forgets this conversation but keeps its soul and memory',
    usage: 'orca bot new-chat [--bot <name>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'bot'],
    notes: [
      'The old chat stays in history. Run from a bot’s Home Chat it starts that bot’s, once its owner asks.'
    ]
  },
  {
    path: ['bot', 'memory', 'forget'],
    hidden: true,
    summary: 'Take a fact out of MEMORY.md',
    usage: 'orca bot memory forget --fact <text> [--bot <name>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'fact', 'bot'],
    notes: [
      'Pass the fact’s words, or its whole line. Every line stating it goes.',
      'Use it to remove or replace a line: one taken out of MEMORY.md any other way is put back when the turn ends.'
    ]
  },
  {
    path: ['bot', 'suggest'],
    hidden: true,
    summary: 'From a look-around run: add one next step to the owner’s Suggestions',
    usage: 'orca bot suggest --title <text> --why <text> --ask <text> [--link <url>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'title', 'why', 'ask', 'link'],
    notes: [
      'Run it from a look-around run; at most 5 a run. --ask is the exact message Start puts in the bot’s message box.'
    ]
  },
  {
    path: ['bot', 'reply'],
    summary: 'Answer, as this bot, in the issue, pull request or thread that woke this run',
    usage:
      'orca bot reply [--text <text> | --text-file <path|->] [--note <path:line:text>]... [--file <path>]... [--file-stdin <filename>] [--choice <label>]... [--react <emoji>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'text',
      'text-file',
      'note',
      'file',
      'file-stdin',
      'choice',
      'react'
    ],
    repeatableFlags: ['note', 'file', 'choice'],
    notes: [
      'For a progress note, a question, line notes or an emoji before your final message, which Orca posts there for you. Anywhere else, use `gh`, `orca linear` or `orca slack`.',
      'On a pull request, each --note posts as an inline review note (up to 30) with --text as the review, and your final message is then not posted; elsewhere notes follow the text as path:line lines.',
      `--file attaches a file (up to ${CONNECTOR_REPLY_MAX_FILES} files, each up to what Slack takes) in the Slack thread that woke you. Repeat it to send several, and put their words in the same call's --text: they post together as one message. GitHub and Linear take no files: link to it instead.`,
      `--choice puts a button under your --text in the Slack thread that woke you (up to ${CONNECTOR_REPLY_MAX_CHOICES}, each up to ${CONNECTOR_REPLY_CHOICE_MAX_CHARS} characters). Repeat it for each option. When someone who can ask you presses one, it comes back to you as their next message in the thread, with the label as its text; the first press is the answer and the buttons close. GitHub and Linear take no buttons.`,
      '--react puts an emoji (👀 ✅, or :shortcode:) on the message that woke you.',
      TEXT_FILE,
      `In Slack: ${SLACK_MENTION} ${SLACK_MARKDOWN}`
    ]
  },
  {
    path: ['bot', 'connectors'],
    summary:
      'Show, per service, which tool to use, who it acts as, whether it is signed in, and where this bot is',
    usage:
      'orca bot connectors [--offer <slack|linear|github|google|webhook> [--workspace <name>]] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'offer', 'workspace'],
    notes: [
      "Run it from a bot's chat. GitHub and Linear act as the bot's owner (gh, orca linear); Slack is the bot itself (orca slack). A service that isn't signed in prints the one line to tell its owner.",
      "Lists each workspace the bot is in (and each Linear workspace's teams) as refs for automations.",
      '--offer shows the owner a Connect card in this chat; --workspace names a workspace or org they asked for that is not listed. Already connected: it says so and shows no card. Signed out of Orca: a connector the bot has, or webhook, shows a Sign in line instead.'
    ]
  },
  {
    path: ['bot', 'import', 'sources'],
    summary: 'List the bots OpenClaw, Hermes and OpenBot keep on this computer, and their folders',
    usage: 'orca bot import sources [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    notes: ['Reads folder names only; it opens no config, keys or databases.']
  },
  {
    path: ['bot', 'import', 'read'],
    summary:
      "Read another app's file for an import, with anything that looks like a secret left out",
    usage: 'orca bot import read <file|folder|->',
    allowedFlags: [...GLOBAL_FLAGS, 'path'],
    positionalArgs: ['path'],
    notes: [
      'A folder lists its files and marks the ones never read. - reads what another command pipes in.',
      'Refuses key, login and chat-history files (.env, auth.json, credentials/, sessions/ and the like), and replaces each line that looks like it holds a secret.'
    ]
  },
  {
    path: ['bot', 'import', 'plan'],
    summary:
      'Show your owner your plan for bringing a bot over from another app, as a card in your chat',
    usage: 'orca bot import plan --file <plan.json> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'file'],
    notes: [
      'Run it from your chat. The file is JSON: {"app","name","again"?,"items":[{"group":"comes|changed|already|stays","what","to"?,"why"}]}.',
      'Your owner ticks what to bring and answers in this chat; write nothing before that answer.'
    ]
  },
  {
    path: ['bot', 'import', 'done'],
    summary: 'Show your owner what an import brought over, as a summary card in your chat',
    usage: 'orca bot import done --file <done.json> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'file'],
    notes: [
      'Run it from your chat. The file is JSON: {"app","name","created":[{"kind":"soul|memory|abilities|automations|tools|other","what","detail"?}],"stayed":[...],"paused":<schedules created paused>}.'
    ]
  },
  {
    path: ['bot', 'tools'],
    summary:
      "List a bot's own tools (MCP servers) and the ones it gets from your Claude Code or Codex",
    usage: 'orca bot tools [--bot <name>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'bot'],
    notes: [
      'Run from a bot’s chat it lists that bot’s tools; a tool that needs a sign-in or won’t start says so.'
    ]
  },
  {
    path: ['bot', 'tools', 'add'],
    summary: 'Give a bot a tool of its own: an MCP server by its URL or the command that starts it',
    usage: 'orca bot tools add <url|command> [--name <name>] [--bot <name>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'source', 'name', 'bot'],
    positionalArgs: ['source'],
    notes: [
      'Quote a command: orca bot tools add "npx -y @notionhq/notion-mcp-server". Only this bot gets it; it keeps every tool from your own setup too.',
      'A server that signs in in a browser needs `orca bot tools connect <name>` once.'
    ]
  },
  {
    path: ['bot', 'tools', 'rm'],
    summary: "Remove one of a bot's own tools",
    usage: 'orca bot tools rm <name> [--bot <name>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'name', 'bot'],
    positionalArgs: ['name']
  },
  {
    path: ['bot', 'tools', 'connect'],
    summary: "Sign one of a bot's own tools in, in the browser",
    usage: 'orca bot tools connect <name> [--finish <address>] [--bot <name>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'name', 'bot', 'finish'],
    positionalArgs: ['name'],
    notes: [
      'Prints the page to open; the sign-in finishes when it is done in the browser.',
      "Signed in on another computer? Its browser ends on a page that can't load: pass that address with --finish.",
      'For a paired server’s bot (--environment), an app Orca signs in to prints its page and waits: paste the address you landed on.'
    ]
  },
  {
    path: ['bot', 'work', 'list'],
    hidden: true,
    summary: 'List the work a bot started: each worker, its state, PR and CI, age and source',
    usage: 'orca bot work list [--bot <name>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'bot'],
    notes: ['Run from a bot’s chat it lists that bot’s work.']
  },
  {
    path: ['bot', 'work', 'forget'],
    hidden: true,
    summary: "Forget this conversation's work, so its next request starts a new worker",
    usage: 'orca bot work forget [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    notes: [
      'Run it from the conversation, only when its owner says to forget the work or start fresh.'
    ]
  },
  {
    path: ['bot', 'look-around', 'set'],
    hidden: true,
    summary: 'Change what a bot looks for, how often, or turn Look around on or off',
    usage:
      'orca bot look-around set [--bot <name>] [--on|--off] [--every every-4h|every-2h|twice-daily|mornings] [--weekdays-only|--every-day] [--focus <text>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'bot',
      'on',
      'off',
      'every',
      'weekdays-only',
      'every-day',
      'focus'
    ],
    notes: [
      'Run from a bot’s chat it changes that bot; the chat shows what changed.',
      '--focus "" clears it, so the bot looks for anything waiting on its owner.'
    ]
  }
]
