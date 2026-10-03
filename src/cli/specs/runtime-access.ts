import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const RUNTIME_ACCESS_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['runtime-access', 'list'],
    summary: 'List revocable runtime pairing grants on this host without credentials',
    usage: 'orca runtime-access list [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    notes: [
      'Run directly on the Orca host, inside its container if applicable. Remote selectors and forwarded SSH/WSL commands are rejected. Pending links are included.'
    ],
    examples: ['orca runtime-access list --json']
  },
  {
    path: ['runtime-access', 'revoke'],
    summary: 'Revoke one runtime pairing grant and disconnect all clients using it',
    usage: 'orca runtime-access revoke --device <deviceId> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'device'],
    notes: [
      'Use the full device ID from runtime-access list. Everyone sharing that grant loses access. Other grants and mobile devices are preserved.'
    ],
    examples: ['orca runtime-access revoke --device <deviceId> --json']
  }
]
