import type { CommandSpec } from '../discovery/command-spec'
import { CLI_GLOBAL_FLAGS as GLOBAL_FLAGS } from '../../shared/cli/cli-argument-boundary'

// Separate from `orca account` (agent accounts): this is the host's own Orca account.
export const AUTH_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['auth', 'login'],
    summary: "Sign this host's Orca in to your Orca account",
    usage: 'orca auth login [--org <id|name>] [--switch] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'org', 'switch'],
    notes: [
      'Prints a link to open in any browser, and a code. Sign in there, check the page shows the same code, and approve; nothing is pasted back.',
      'The running Orca on this host keeps the sign-in; this command never writes it. Start Orca on this host first.',
      '--switch replaces an account that is already signed in. --org picks the organization when you belong to more than one.'
    ],
    examples: ['orca auth login', 'orca auth login --org Acme', 'orca auth login --switch']
  },
  {
    path: ['auth', 'status'],
    summary: "Show which Orca account this host's Orca is signed in to",
    usage: 'orca auth status [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    notes: ['Exits 0 when signed in and 1 otherwise.'],
    examples: ['orca auth status']
  },
  {
    path: ['auth', 'logout'],
    summary: "Sign this host's Orca out of its Orca account",
    usage: 'orca auth logout [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    examples: ['orca auth logout']
  }
]
