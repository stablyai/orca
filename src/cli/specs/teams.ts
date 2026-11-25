import type { CommandSpec } from '../discovery/command-spec'
import { CLI_GLOBAL_FLAGS as GLOBAL_FLAGS } from '../../shared/cli/cli-argument-boundary'
import { TEXT_FILE } from './slack'

const ON_THIS_COMPUTER =
  'The sign-in is kept by the Orca this command talks to (this computer or an `orca serve` server) and never leaves it. Off until you connect it.'
const OWNER_ONLY = "Owner only: refused from a bot's chat."
const AS_YOU =
  "Acts in Microsoft Teams as the person who connected it, never as a separate bot account. From a bot's chat it works once that bot has Teams on (`orca teams bot`)."
const PLACE =
  'A place is a ref from `orca teams find` or `orca teams read` (teams:chat/…, teams:channel/…) or a link from Teams’ Copy link.'

export const TEAMS_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['teams', 'status'],
    summary: 'Show the Microsoft Teams sign-in here, what it allows, and which bots may use it',
    usage: 'orca teams status [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    notes: [ON_THIS_COMPUTER]
  },
  {
    path: ['teams', 'connect'],
    summary: 'Sign in to Microsoft Teams through your Entra app, with a code typed on any device',
    usage: 'orca teams connect --tenant <id|domain> --client <app id> [--chats-only] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'tenant', 'client', 'chats-only'],
    booleanFlags: ['chats-only'],
    notes: [
      ON_THIS_COMPUTER,
      'Prints a Microsoft page and a code: open it on any device, enter the code and sign in. Works on a server with no browser.',
      '--client is the Application (client) ID of an app registration in your Entra tenant with "Allow public client flows" on. See the Microsoft Teams section of the CLI reference for its permissions.',
      '--chats-only leaves channels out, so no admin consent is needed (ChannelMessage.Read.All always needs one).',
      'Connecting again replaces the sign-in here.',
      OWNER_ONLY
    ],
    examples: [
      'orca teams connect --tenant contoso.onmicrosoft.com --client 00000000-0000-0000-0000-000000000000',
      'orca teams connect --tenant contoso.onmicrosoft.com --client 00000000-0000-0000-0000-000000000000 --chats-only'
    ]
  },
  {
    path: ['teams', 'disconnect'],
    summary: 'Remove the Microsoft Teams sign-in from this Orca',
    usage: 'orca teams disconnect [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    notes: [
      'Deletes the sign-in here. Microsoft keeps your consent to the app until you remove it at https://myapps.microsoft.com.',
      OWNER_ONLY
    ]
  },
  {
    path: ['teams', 'bot'],
    summary: "Turn a bot's use of Microsoft Teams on or off",
    usage: 'orca teams bot <bot> --on|--off [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'bot', 'on', 'off'],
    booleanFlags: ['on', 'off'],
    positionalArgs: ['bot'],
    notes: [
      'Off for every bot until you turn it on. The bot then reads and posts in Teams as you, for whoever its Who can ask lets ask it, and in its automations. Turning it on says who else can ask that bot.',
      OWNER_ONLY
    ],
    examples: ['orca teams bot Scout --on', 'orca teams bot Scout --off']
  },
  {
    path: ['teams', 'find'],
    summary: 'Find Microsoft Teams chats by topic or person, and channels by team or channel name',
    usage: 'orca teams find <name|@person|#channel|link> [--limit <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'query', 'limit'],
    positionalArgs: ['query'],
    notes: [
      AS_YOU,
      '@name looks only at chats, #name only at channels; quote them in the shell. A ref or link prints its label.',
      'Looks through your 200 most recent chats and the channels of up to 50 teams. --limit is 1 to 50 (default 20).',
      'Never picks one for you; pass the ref you mean to the next command.'
    ],
    examples: ['orca teams find "@Ada Lovelace"', 'orca teams find "#releases"']
  },
  {
    path: ['teams', 'read'],
    summary: 'Read the latest messages in a Teams chat, channel or channel thread, oldest first',
    usage: 'orca teams read <place> [--limit <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'ref', 'limit'],
    positionalArgs: ['ref'],
    notes: [
      AS_YOU,
      PLACE,
      'A channel shows its thread starters; read a message ref from one to see the thread. --limit is 1 to 50 (default 20).',
      'Each message prints a ref for `orca teams react`; in a channel, `orca teams post` to it answers in its thread.'
    ]
  },
  {
    path: ['teams', 'post'],
    summary: 'Post in a Teams chat or channel, or reply in a channel thread, as you',
    usage: 'orca teams post <place> (<text> | --text-file <path|->) [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'ref', 'text', 'text-file'],
    positionalArgs: ['ref', 'text'],
    notes: [
      AS_YOU,
      PLACE,
      'A channel message ref replies in its thread. A chat has no threads: a chat message ref posts in the chat.',
      'Text is posted as typed: no formatting, and an @name is plain words that notify no one.',
      TEXT_FILE
    ]
  },
  {
    path: ['teams', 'react'],
    summary: 'React to a Teams message with an emoji, as you',
    usage: 'orca teams react <message> <emoji> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'ref', 'emoji'],
    positionalArgs: ['ref', 'emoji'],
    notes: [AS_YOU, 'The message is a ref from `orca teams read` or a message link from Teams.'],
    examples: ['orca teams react teams:chat/19:abc@thread.v2/1732550000000 👍']
  }
]
