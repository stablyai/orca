import type { CommandSpec } from '../discovery/command-spec'
import { CLI_GLOBAL_FLAGS as GLOBAL_FLAGS } from '../../shared/cli/cli-argument-boundary'

export const BOT_COMPOSIO_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['bot', 'composio', 'setup'],
    summary:
      "Put the next Composio setup card in this bot's chat: the owner's key, then the app's sign-in",
    usage: 'orca bot composio setup [--app <slug>] [--name <app name>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'app', 'name'],
    notes: [
      "Run it from the bot's chat. Orca draws the card from its own state; you can't post cards yourself.",
      'The owner\'s clicks reach you as "Card composio-setup/<card> answered: …". Run it again with --app after the key is added if you had no app then.'
    ]
  },
  {
    path: ['bot', 'composio', 'events'],
    summary:
      "Put the card in this bot's chat that sends a Composio trigger's events to one of its webhooks",
    usage:
      'orca bot composio events --hook <hook id> --trigger <TRIGGER_SLUG> [--config <json>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'hook', 'trigger', 'config'],
    notes: [
      "Make the webhook's automation first; `orca webhooks list --bot <name>` gives its hook id.",
      "One click on the card points the Composio project's events at the hook, saves Composio's signing secret on it and turns the trigger on. Your owner's answer reaches you as \"Card composio-setup/events answered: …\"."
    ]
  }
]
