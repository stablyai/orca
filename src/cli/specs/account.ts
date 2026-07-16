import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

// Why: the desktop "Add account" button is disabled when the UI drives a remote
// runtime (a headless server). These commands run the interactive agent login
// (`claude login` / `codex login`) in the caller's own terminal on the host and
// register the captured account with the local runtime, giving headless hosts a
// way to manage Claude and Codex accounts.
export const ACCOUNT_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['account', 'add'],
    summary: 'Add a managed Claude or Codex account by signing in on this Orca host',
    usage: 'orca account add [--agent claude|codex] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'agent'],
    notes: [
      'Runs the agent login (`claude login` / `codex login`) in this terminal, then registers the account with the local Orca runtime.',
      'Sign in with the account you want to add (e.g. use a private/incognito browser window for a second account).',
      '--agent defaults to claude. Requires the Orca runtime to be running on this machine.'
    ],
    examples: ['orca account add', 'orca account add --agent codex']
  },
  {
    path: ['account', 'list'],
    summary: 'List managed Claude and Codex accounts on this Orca host',
    usage: 'orca account list [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    examples: ['orca account list']
  }
]
