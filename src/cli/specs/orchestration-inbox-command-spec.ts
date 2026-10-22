import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const ORCHESTRATION_INBOX_COMMAND_SPEC: CommandSpec = {
  path: ['orchestration', 'inbox'],
  summary: 'Show messages across (or for) recipients',
  usage:
    'orca orchestration inbox [--limit <n>] [--terminal <handle>] [--run <run_id>] [--full] [--json]',
  allowedFlags: [...GLOBAL_FLAGS, 'limit', 'terminal', 'run', 'full'],
  notes: [
    '--terminal reads messages addressed directly to that terminal and reports its current Run binding.',
    '--run reads the Run mailbox and rejects a terminal that is bound to a different Run.'
  ],
  identityFlagRoles: { terminal: 'target' }
}
