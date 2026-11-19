import { CLI_GLOBAL_FLAGS as GLOBAL_FLAGS } from '../../shared/cli/cli-argument-boundary'
import type { CommandSpec } from '../discovery/command-spec'

// Hidden until the bot preamble teaches them; the owner's panel comes with it.
const ITEM_NOTES = [
  "Run from a bot's chat: the item belongs to that bot and chat. Numbers are per computer; --environment reads another one.",
  'Each text flag has a -file twin that reads a file or - (stdin), so quotes and backticks need no escaping.'
]

const WRITE_FLAGS = GLOBAL_FLAGS

export const BOT_ITEM_ASK_BOOLEAN_FLAGS = ['multi'] as const

export const BOT_ITEM_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['bot', 'item', 'add'],
    hidden: true,
    summary: 'Track a deliverable or a decision for your owner as an item',
    usage:
      'orca bot item add --title <text> [--description <markdown>] [--done-means <text>] [--status planned|in-progress] [--link <ref>]... [--for bot:<name>] [--chat <id>] [--json]',
    allowedFlags: [
      ...WRITE_FLAGS,
      'title',
      'description',
      'description-file',
      'done-means',
      'done-means-file',
      'status',
      'link',
      'for',
      'chat'
    ],
    repeatableFlags: ['link'],
    notes: [
      ...ITEM_NOTES,
      'Before adding an item about a PR, issue or thread, run `orca bot item list --link <it>`; if one already covers it, update that item.',
      'For work already underway, --link its workers (dispatch:<ctx_id>) and its PR by full URL when known; workers started later with `worker-start --item <n>` link themselves.',
      '--for bot:<name> makes the item for another bot, in its Home Chat or --chat; --chat alone makes it in another of your own chats. Either is sent as a request, carrying whom your turn is for, and a refused request makes no item.'
    ]
  },
  {
    path: ['bot', 'item', 'set'],
    hidden: true,
    summary: "Change an item's title, description, done-means or status",
    usage:
      'orca bot item set <id> [--title <text>] [--description <markdown>] [--done-means <text>] [--status planned|in-progress|needs-you|done|canceled] [--comment <text>] [--ask <question> [--option <label>[ | <detail>]]... [--recommended <n>] [--multi]]... [--note <why>] [--reason <why>] [--json]',
    repeatableFlags: ['ask', 'option', 'recommended'],
    booleanFlags: [...BOT_ITEM_ASK_BOOLEAN_FLAGS],
    allowedFlags: [
      ...WRITE_FLAGS,
      'id',
      'title',
      'description',
      'description-file',
      'done-means',
      'done-means-file',
      'status',
      'note',
      'note-file',
      'reason',
      'reason-file',
      'comment',
      'comment-file',
      'ask',
      'option',
      'recommended',
      'multi'
    ],
    positionalArgs: ['id'],
    notes: [
      ...ITEM_NOTES,
      'Needs you takes the question for your owner. A decision with known choices goes as --status needs-you --ask "<question>" --option "<choice>" --option "<choice>" [--recommended <n>], one --ask per decision, each followed by its options ("<label> | <detail>" adds a line under the label; --multi lets them pick several; an --ask with no options takes a written answer). --comment is then the short context above them. An open question with no choices goes as --comment "..." alone.',
      "Your owner answers in Orca (every decision answered, all in one answer); the answer comes in your mail and moves the item back to In progress. A plain comment from them is not a recorded answer, but it also moves the item to In progress; if your question still stands, set needs-you again with only what's left.",
      '--comment goes with any --status and is recorded with the move. --status done is `done`; --status canceled needs --reason, like `cancel`.',
      'Reopen your closed item with --status planned or in-progress (field changes on a closed item come only with a reopen); one your owner canceled, ask about on the item instead. --description "" clears it.'
    ]
  },
  {
    path: ['bot', 'item', 'comment'],
    hidden: true,
    summary: 'Add what your owner would want to read later to an item',
    usage: 'orca bot item comment <id> --text <text> [--json]',
    allowedFlags: [...WRITE_FLAGS, 'id', 'text', 'text-file'],
    positionalArgs: ['id'],
    notes: [
      ...ITEM_NOTES,
      "Allowed in any status, closed included. Put worker results here, not in chat. You can also comment on an item you made for another bot with --for: it goes to that item's chat as your request, carrying whom your turn is for."
    ]
  },
  {
    path: ['bot', 'item', 'done'],
    hidden: true,
    summary: 'Close an item whose done-means is met',
    usage: 'orca bot item done <id> [--note <text>] [--json]',
    allowedFlags: [...WRITE_FLAGS, 'id', 'note', 'note-file'],
    positionalArgs: ['id'],
    notes: ITEM_NOTES
  },
  {
    path: ['bot', 'item', 'cancel'],
    hidden: true,
    summary: 'Close an item that was dropped, with the reason',
    usage: 'orca bot item cancel <id> --reason <text> [--json]',
    allowedFlags: [...WRITE_FLAGS, 'id', 'reason', 'reason-file'],
    positionalArgs: ['id'],
    notes: ITEM_NOTES
  },
  {
    path: ['bot', 'item', 'link'],
    hidden: true,
    summary: 'Link workers, PRs, URLs or files to an item',
    usage: 'orca bot item link <id> <ref>... [--json]',
    allowedFlags: [...WRITE_FLAGS, 'id', 'ref'],
    repeatableFlags: ['ref'],
    positionalArgs: ['id', 'ref'],
    variadicPositional: true,
    notes: [
      ...ITEM_NOTES,
      '<ref> is dispatch:<ctx_id>, pr:<owner/repo#n> (or the PR URL), a URL or a file path. Workers started with `worker-start --item` link themselves.'
    ]
  },
  {
    path: ['bot', 'item', 'list'],
    hidden: true,
    summary: "List a bot's items, newest change first",
    usage:
      'orca bot item list [--bot <name>] [--status <s>[,<s>]] [--all] [--chat <id>|--here] [--link <ref>] [--limit <n>] [--cursor <c>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'bot',
      'status',
      'all',
      'chat',
      'here',
      'link',
      'limit',
      'cursor'
    ],
    notes: [
      'Open items (Needs you, In progress, Planned) by default; --all adds closed ones; --status picks exact statuses and wins over --all.',
      '--link <ref> lists only items linking that PR, URL or file; a PR URL and pr:<owner/repo#n> match.',
      '50 a page (at most 100 with --limit); pass the printed --cursor for the next page.'
    ]
  },
  {
    path: ['bot', 'item', 'show'],
    hidden: true,
    summary: 'Show one item and its activity',
    usage: 'orca bot item show <id> [--after <eventId>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id', 'after'],
    positionalArgs: ['id'],
    notes: ['--after e41 prints only the events after e41; each update you get names its event.']
  }
]
