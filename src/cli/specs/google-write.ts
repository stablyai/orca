import { GMAIL_DRAFT_ATTACH_MAX_BYTES } from '../../shared/google/gmail-draft-request-budget'
import type { CommandSpec } from '../discovery/command-spec'
import { CLI_GLOBAL_FLAGS as GLOBAL_FLAGS } from '../../shared/cli/cli-argument-boundary'

const AS_OWNER =
  "Acts as the Google account connected on this computer (your owner's, in a bot), with --account <email> when there are several. A bot needs its owner to turn Google on for it."
const ASKED_BY =
  'When someone other than your owner asked, Orca ends the text with "asked by <name> via <you>".'
const NOTIFY = 'Guests get Google’s normal emails about it; --no-notify skips them.'
const ONE_OCCURRENCE =
  'On a repeating event this changes the one occurrence named (refs from `orca calendar list` are occurrences); --series changes all of them.'

export const GOOGLE_WRITE_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['gmail', 'draft'],
    summary: 'Save a mail draft: new, a reply, a forward, or a revision of one',
    usage:
      'orca gmail draft --to <email> --subject <text> (--body <text> | --body-file <path|->) [--reply-to <gmail:msg:…> [--reply-all]] [--forward <gmail:msg:…>] [--draft <gmail:draft:…>] [--cc <email>] [--bcc <email>] [--attach <path>] [--account <email>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'to',
      'cc',
      'bcc',
      'subject',
      'body',
      'body-file',
      'reply-to',
      'reply-all',
      'forward',
      'draft',
      'attach',
      'account'
    ],
    repeatableFlags: ['to', 'cc', 'bcc', 'attach'],
    booleanFlags: ['reply-all'],
    notes: [
      AS_OWNER,
      'Only saves: nothing is sent until `orca gmail send <draft>`. When the person asked you to send it, send it; otherwise the draft waits for your owner in Gmail.',
      'A reply goes to the sender (everyone on it with --reply-all), stays in its thread and keeps the "Re:" subject; --to and --cc add people. --forward includes the message and its attachments.',
      `--draft revises a saved draft after feedback, keeping what you don’t pass; a new --body replaces all its text, a reply’s quote included. --to, --cc and --bcc repeat or take commas. --attach repeats, up to ${Math.floor(GMAIL_DRAFT_ATTACH_MAX_BYTES / 1024)} KB in all: share a Drive link for bigger files.`,
      ASKED_BY
    ],
    examples: [
      'orca gmail draft --to sam@acme.dev --subject "Q3 plan" --body-file -',
      'orca gmail draft --reply-to gmail:msg:18c2f0a1b2c3d4e5 --reply-all --body "Thanks, Thursday works."',
      'orca gmail draft --draft gmail:draft:r-123 --body "Shorter version"'
    ]
  },
  {
    path: ['gmail', 'send'],
    summary: 'Send a saved draft',
    usage: 'orca gmail send <gmail:draft:…> [--account <email>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'ref', 'account'],
    positionalArgs: ['ref'],
    notes: [
      AS_OWNER,
      'Sends from your owner’s address, as written. Send when the person asked you to send ("send it"); an automation drafts for your owner instead, unless its instructions say to send.'
    ],
    examples: ['orca gmail send gmail:draft:r-123']
  },
  {
    path: ['gmail', 'archive'],
    summary: 'Archive mail (take it out of the inbox)',
    usage: 'orca gmail archive <gmail:thread:…|gmail:msg:…>... [--account <email>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'ref', 'account'],
    positionalArgs: ['ref'],
    variadicPositional: true,
    repeatableFlags: ['ref'],
    notes: [AS_OWNER],
    examples: ['orca gmail archive gmail:thread:18c2f0a1b2c3d4e5 gmail:thread:18c2f0a1b2c3d4e6']
  },
  {
    path: ['gmail', 'label'],
    summary: 'Add or take off Gmail labels by name',
    usage:
      'orca gmail label <gmail:thread:…|gmail:msg:…>... [--add <label>] [--remove <label>] [--account <email>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'ref', 'add', 'remove', 'account'],
    positionalArgs: ['ref'],
    variadicPositional: true,
    repeatableFlags: ['ref', 'add', 'remove'],
    valueFlags: ['remove'],
    notes: [
      AS_OWNER,
      'Labels by name; --add makes a label that doesn’t exist yet. Starred, Important, Unread and Inbox work too.'
    ],
    examples: ['orca gmail label gmail:thread:18c2f0a1b2c3d4e5 --add Receipts --remove "To do"']
  },
  {
    path: ['gmail', 'mark-read'],
    summary: 'Mark mail as read',
    usage: 'orca gmail mark-read <gmail:thread:…|gmail:msg:…>... [--account <email>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'ref', 'account'],
    positionalArgs: ['ref'],
    variadicPositional: true,
    repeatableFlags: ['ref'],
    notes: [AS_OWNER],
    examples: ['orca gmail mark-read gmail:thread:18c2f0a1b2c3d4e5']
  },
  {
    path: ['calendar', 'create'],
    summary: 'Create a calendar event, optionally with guests and a Meet link',
    usage:
      'orca calendar create --title <text> --start <time|day> [--end <time|day> | --duration <30m>] [--all-day] [--tz <zone>] [--with <email>] [--where <text>] [--body <text> | --body-file <path|->] [--repeat <RRULE>] [--meet] [--no-notify] [--calendar <id|name>] [--account <email>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'title',
      'start',
      'end',
      'duration',
      'all-day',
      'tz',
      'with',
      'where',
      'body',
      'body-file',
      'repeat',
      'meet',
      'no-notify',
      'calendar',
      'account'
    ],
    repeatableFlags: ['with'],
    booleanFlags: ['all-day', 'meet', 'no-notify'],
    notes: [
      AS_OWNER,
      'Times are 2026-11-04T10:00 in the calendar’s zone (or --tz America/New_York), or carry their offset. 30 minutes unless --end or --duration. --all-day takes days; --end is the last day.',
      `${NOTIFY} Add --meet only when asked for a video call.`,
      '--repeat takes an RRULE: FREQ=WEEKLY;BYDAY=TU;COUNT=6.',
      ASKED_BY
    ],
    examples: [
      'orca calendar create --title "Q3 review" --start 2026-11-05T14:00 --duration 45m --with sam@acme.dev --meet',
      'orca calendar create --title Offsite --start 2026-11-12 --end 2026-11-13 --all-day'
    ]
  },
  {
    path: ['calendar', 'update'],
    summary: 'Change a calendar event: time, title, place, guests, Meet link',
    usage:
      'orca calendar update <calendar:…:event:…> [--title <text>] [--start <time|day>] [--end <time|day> | --duration <30m>] [--tz <zone>] [--where <text>] [--body <text> | --body-file <path|->] [--with <email>] [--without <email>] [--meet] [--series] [--no-notify] [--account <email>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'ref',
      'title',
      'start',
      'end',
      'duration',
      'tz',
      'where',
      'body',
      'body-file',
      'with',
      'without',
      'meet',
      'series',
      'no-notify',
      'calendar',
      'account'
    ],
    positionalArgs: ['ref'],
    repeatableFlags: ['with', 'without'],
    booleanFlags: ['meet', 'series', 'no-notify'],
    notes: [
      AS_OWNER,
      'Only what you pass changes; a new --start keeps the event’s length. --with invites people, --without uninvites them.',
      ONE_OCCURRENCE,
      NOTIFY
    ],
    examples: [
      'orca calendar update calendar:primary:event:7a1b2c_20261105T190000Z --start 2026-11-05T15:00',
      'orca calendar update calendar:primary:event:7a1b2c --with ana@acme.dev'
    ]
  },
  {
    path: ['calendar', 'delete'],
    aliases: [['calendar', 'rm']],
    summary: 'Cancel a calendar event, or take it off this calendar',
    usage:
      'orca calendar delete <calendar:…:event:…> [--series] [--no-notify] [--account <email>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'ref', 'series', 'no-notify', 'calendar', 'account'],
    positionalArgs: ['ref'],
    booleanFlags: ['series', 'no-notify'],
    destructive: true,
    notes: [
      AS_OWNER,
      ONE_OCCURRENCE,
      'An event your owner organizes is cancelled for everyone, and guests are told unless --no-notify; one they were invited to only leaves this calendar.'
    ],
    examples: ['orca calendar delete calendar:primary:event:7a1b2c_20261105T190000Z']
  },
  {
    path: ['calendar', 'respond'],
    summary: 'Answer an invitation: accept, decline or maybe',
    usage:
      'orca calendar respond <calendar:…:event:…> accept|decline|maybe [--series] [--account <email>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'ref', 'answer', 'series', 'calendar', 'account'],
    positionalArgs: ['ref', 'answer'],
    booleanFlags: ['series'],
    notes: [AS_OWNER, ONE_OCCURRENCE],
    examples: ['orca calendar respond calendar:primary:event:7a1b2c_20261105T190000Z accept']
  },
  {
    path: ['calendar', 'suggest-time'],
    summary: 'Find free times for you and other people',
    usage:
      'orca calendar suggest-time --with <email> --duration <30m> [--hours 09:00-17:00] [--from <day|time>] [--to <day|time>] [--account <email>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'with', 'duration', 'hours', 'from', 'to', 'account'],
    repeatableFlags: ['with'],
    notes: [
      AS_OWNER,
      'Ranked free slots on weekdays between --hours (09:00-17:00 by default) in your owner’s time zone, over the next week unless --from/--to (up to 14 days).',
      'Takes emails (`orca contacts find <name>` looks them up). A calendar Google won’t show is listed as unknown, never counted as free: say so when you offer times.'
    ],
    examples: ['orca calendar suggest-time --with sam@acme.dev,ana@acme.dev --duration 30m']
  }
]
