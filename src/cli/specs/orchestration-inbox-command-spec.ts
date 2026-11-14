import { CLI_GLOBAL_FLAGS as GLOBAL_FLAGS } from '../../shared/cli-argument-boundary'
import type { CommandSpec } from '../discovery/command-spec'

export const ORCHESTRATION_INBOX_COMMAND_SPEC: CommandSpec = {
  path: ['orchestration', 'inbox'],
  summary: 'Show messages across (or for) recipients',
  usage:
    'orca orchestration inbox [--limit <n>] [--terminal <handle>] [--run <run_id>] [--full] [--json]',
  allowedFlags: [...GLOBAL_FLAGS, 'limit', 'terminal', 'run', 'full'],
  identityFlagRoles: { terminal: 'target' },
  notes: [
    '--terminal reads messages addressed directly to that terminal and reports its current Run binding.',
    '--run reads the Run mailbox and rejects a terminal that is bound to a different Run.',
    'Rows preview each body in 200 characters and keep only payload ids; --full prints them whole.'
  ]
}
