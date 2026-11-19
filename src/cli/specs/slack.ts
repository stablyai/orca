import type { CommandSpec } from '../discovery/command-spec'
import { CLI_GLOBAL_FLAGS as GLOBAL_FLAGS } from '../../shared/cli/cli-argument-boundary'

const AS_BOT =
  "Run it from a bot's chat or one of its automation runs; it acts as that bot's own Slack app, only where the bot already is. GitHub and Linear are your owner's: use `gh` and `orca linear`."
const PLACE =
  'A place or message is a ref from an earlier command (slack:T…:C…[:thread][:message]), a Slack link or a #name; output always shows the ref and a label. Quote #names in the shell.'
const TO_PERSON =
  'A person ref from `orca slack find @name` (slack:T…:user:U…) posts in a DM with them, opening one if needed.'
const WOKEN = 'To answer the thread that woke you, use `orca bot reply`; a post there is refused.'
export const TEXT_FILE =
  'Pass multiline text as a file with --text-file <path> (- reads stdin), not a heredoc: heredocs can hang the shell when macOS pipe memory is low.'
const POSTED_REF =
  'Prints a ref for this post at once, before or after Slack sends it: `orca slack edit` or `delete` it, or post to it to answer in its thread, and each goes in order. Once sent, the ref acts on the message itself.'
export const SLACK_MENTION =
  "Mention a person with <@USERID> (`orca slack find @name` shows it); ping a channel with <!here>, <!channel> or <!everyone>, a user group with <!subteam^GROUPID>. Only that exact form pings: a read's `@Name (user:USERID)`, `@here` or `@team (group:GROUPID)` pings no one."
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
      'A message lists its files by id; `read <message> --download <id>` saves one (up to 640 KB) to --out, or under its own name here.'
    ]
  },
  {
    path: ['slack', 'post'],
    summary: 'Post a message in a Slack channel, thread or DM as this bot',
    usage: 'orca slack post <place> (<text> | --text-file <path|->) [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'ref', 'text', 'text-file'],
    positionalArgs: ['ref', 'text'],
    notes: [
      AS_BOT,
      PLACE,
      TO_PERSON,
      `A message ref posts in its thread. ${WOKEN}`,
      POSTED_REF,
      TEXT_FILE,
      SLACK_MENTION,
      SLACK_MARKDOWN
    ]
  },
  {
    path: ['slack', 'attach'],
    summary: 'Attach a file in a Slack channel, thread or DM as this bot, with an optional comment',
    usage:
      'orca slack attach <place> --file <path> [--text <comment> | --text-file <path|->] [--json]',
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
      'The emoji is a common one (👀 ✅ 👍) or its :shortcode:. Reacting twice, or removing one that is gone, is not an error. On the message that woke you, `orca bot reply --react` needs no ref.'
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
