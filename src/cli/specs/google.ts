import type { CommandSpec } from '../discovery/command-spec'
import { CLI_GLOBAL_FLAGS as GLOBAL_FLAGS } from '../../shared/cli/cli-argument-boundary'

const ON_THIS_COMPUTER =
  'Google sign-ins are kept by the Orca running on this computer (your Mac or an `orca serve` server) and never leave it.'
const OWNER_ONLY = "Owner only: refused from a bot's chat."

export const GOOGLE_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['google', 'status'],
    summary:
      'Show the Google client and accounts on this computer, which services work, and which bots may use them',
    usage: 'orca google status [--check] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'check'],
    notes: [
      ON_THIS_COMPUTER,
      'Each service reads Ready, Needs permission (reconnect and allow it), API off (with the Google Cloud page that turns it on), or Blocked by your company admin.',
      '--check reads each service again now instead of showing the last check.'
    ],
    examples: ['orca google status', 'orca google status --check']
  },
  {
    path: ['google', 'client', 'import'],
    summary: "Add your team's Google client (a Desktop app client file) to this computer",
    usage: 'orca google client import <file> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'file'],
    positionalArgs: ['file'],
    notes: [
      'Create it once in Google Cloud Console: Credentials › Create credentials › OAuth client ID › Desktop app, then download the file.',
      'Web app clients, service-account keys and saved sign-ins are refused, with what to download instead.',
      OWNER_ONLY
    ],
    examples: ['orca google client import ~/Downloads/client_secret_123.json']
  },
  {
    path: ['google', 'client', 'export'],
    summary: "Save this computer's Google client as a file to hand to teammates",
    usage: 'orca google client export --out <file> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'out'],
    notes: [
      'Writes the Desktop app client file back out, for a teammate to `orca google client import`. Google treats this kind of client as public; each person still signs in to their own account.',
      'Never contains anyone’s sign-in.',
      OWNER_ONLY
    ],
    examples: ['orca google client export --out ~/Desktop/acme-google-client.json']
  },
  {
    path: ['google', 'connect'],
    summary: 'Sign a Google account in on this computer',
    usage: 'orca google connect [--services gmail,calendar,files] [--account <email>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'account', 'services'],
    notes: [
      ON_THIS_COMPUTER,
      "Opens your browser when Orca here has one. Otherwise it prints a link: sign in on any device, then paste the address of the page that couldn't load back here. Only a sign-in this computer just started is accepted, for 5 minutes.",
      '--services picks what Google is asked for: gmail, calendar, files (Drive, Docs and Sheets). Without it: what the account already has, else all three. Looking people up by name is always included. Adding a service later keeps the ones already allowed.',
      '--account picks the account on Google’s page, e.g. to reconnect it or add a service. Connecting another account adds it.',
      OWNER_ONLY
    ],
    examples: [
      'orca google connect',
      'orca google connect --services gmail,calendar',
      'orca google connect --account me@example.com --services files'
    ]
  },
  {
    path: ['google', 'disconnect'],
    summary: 'Remove a Google account from this computer, and optionally revoke it at Google',
    usage: 'orca google disconnect [--account <email>] [--revoke] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'account', 'revoke'],
    notes: [
      'Without --revoke the sign-in is deleted here only; Google still lists the app under your account’s third-party access. --revoke cancels it at Google too.',
      '--account is needed when more than one account is connected. Removing the default makes the oldest account left the default.',
      OWNER_ONLY
    ],
    examples: ['orca google disconnect', 'orca google disconnect --account me@example.com --revoke']
  },
  {
    path: ['google', 'default'],
    summary: 'Show or set the Google account used when a command or automation names none',
    usage: 'orca google default [<email>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'account'],
    positionalArgs: ['account'],
    notes: [
      'Without --account, Google commands and automation rules use this account. The first account connected here is the default until you pick another; removing it makes the oldest one left the default.',
      'With no email, prints the default.',
      "From a bot's chat, works once Google is on for that bot."
    ],
    examples: ['orca google default', 'orca google default me@example.com']
  },
  {
    path: ['google', 'bot'],
    summary: "Turn a bot's use of Google on or off, or choose its accounts",
    usage: 'orca google bot <bot> --on|--off|--accounts <emails> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'bot', 'on', 'off', 'accounts'],
    positionalArgs: ['bot'],
    notes: [
      'Off for every bot until you turn it on. A bot then uses Google as you, like gh and orca linear: for whoever its Who can ask lets ask it, and in its automations. Turning it on says who else can ask that bot.',
      '--on gives it every Google account on this computer, now and later; --accounts gives it only those (comma-separated). Without --account, its calls use the computer default if it has it, else the first account given.',
      OWNER_ONLY
    ],
    examples: [
      'orca google bot Scout --on',
      'orca google bot Scout --accounts me@work.com,me@gmail.com',
      'orca google bot Scout --off'
    ]
  }
]
