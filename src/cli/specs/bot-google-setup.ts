import type { CommandSpec } from '../discovery/command-spec'
import { CLI_GLOBAL_FLAGS as GLOBAL_FLAGS } from '../../shared/cli/cli-argument-boundary'

const FROM_CHAT =
  "Run it from the bot's chat. The setup cards in the chat draw from this run; you can't post cards yourself."
const OWNER_CLICKS =
  'While the person does the clicking (Guide me here, or Let me do this one), they do every action on that page: never click, fill or type there. Only their own card answer hands the clicking back.'

export const BOT_GOOGLE_SETUP_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['bot', 'google-setup', 'show'],
    summary:
      "Show this bot's Google setup: path, each step and who did it, and the owner's answers",
    usage: 'orca bot google-setup show [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    notes: [
      FROM_CHAT,
      'When the setup waits on your owner, it says why and lists the buttons their card shows. Name only those, in those words.'
    ]
  },
  {
    path: ['bot', 'google-setup', 'start'],
    summary: 'Start Google setup for this bot, or pick up the one already running',
    usage:
      'orca bot google-setup start [--mode do-it-for-me|guide-here|guide-browser] [--page <browser page id>] [--new-app] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'mode', 'page', 'new-app'],
    booleanFlags: ['new-app'],
    notes: [
      FROM_CHAT,
      '--new-app makes a new Google app when this computer already has one (without it, start shows the Connect card): for another company, when Google refused a sign-in through the current app, or for a work account without the unverified-app warning. Not for adding another account the current app works for. New sign-ins then use the new app; accounts already connected keep theirs.',
      'Until your owner picks a path on the card, you only read pages (Guide me here); --mode guide-browser when they asked to use their own browser. --page names the browser page the setup runs in.'
    ]
  },
  {
    path: ['bot', 'google-setup', 'step'],
    summary: 'Mark a setup step active, done, skipped or failed',
    usage:
      'orca bot google-setup step <account|project|apis|branding|links|publish|client|connect> --status <active|done|skipped|failed|pending> [--note <text>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'step', 'status', 'note'],
    positionalArgs: ['step'],
    notes: [
      'Mark a step done only after reading the page shows it finished.',
      'Connect, a step the person took with Let me do this one, and one you handed them finish only with their Done on its card. The sign-in screen step is the exception: once you read its policy box ticked, mark it done.',
      'Who did it is recorded from the path: you in Do it for me, the person otherwise.'
    ]
  },
  {
    path: ['bot', 'google-setup', 'need-user'],
    summary: 'Hand a step to the person, with what they need to do',
    usage: 'orca bot google-setup need-user <step> --note <what to do> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'step', 'note'],
    positionalArgs: ['step'],
    notes: [
      'Use it for the policy box (never tick it yourself) and after one or two misses on a step.',
      OWNER_CLICKS
    ]
  },
  {
    path: ['bot', 'google-setup', 'set'],
    summary: 'Record the account, work or personal, the project id, the services, or the page',
    usage:
      'orca bot google-setup set [--account <email>] [--accounts <a,b>] [--kind work|personal] [--project <id>] [--services gmail,calendar,files] [--page <browser page id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'account', 'accounts', 'kind', 'project', 'services', 'page'],
    notes: [
      'With one Google account signed in on the page, set --account to it. With two or more, set --accounts and the owner picks on a card.'
    ]
  },
  {
    path: ['bot', 'google-setup', 'answer'],
    summary:
      'Record what the person typed as their answer to a setup card, so the card locks to it',
    usage: 'orca bot google-setup answer <path|account|kind|services|step> --values <a,b> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'card', 'values'],
    positionalArgs: ['card'],
    notes: [
      'Only for what the person typed in chat; their clicks are recorded already and reach you as "Card google-setup/<card> answered: …".',
      OWNER_CLICKS
    ]
  },
  {
    path: ['bot', 'google-setup', 'done'],
    summary: 'Finish Google setup once the owner has signed in with the new app',
    usage: 'orca bot google-setup done [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    notes: [
      'Refused until your owner has signed in and Google answers for every chosen service; the refusal says what is left and which button on their card fixes it.'
    ]
  },
  {
    path: ['bot', 'google-setup', 'fail'],
    summary: "End Google setup when it can't go on, with why",
    usage: 'orca bot google-setup fail --error <text> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'error']
  }
]
