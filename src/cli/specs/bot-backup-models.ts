import { CLI_GLOBAL_FLAGS as GLOBAL_FLAGS } from '../../shared/cli/cli-argument-boundary'
import type { CommandSpec } from '../discovery/command-spec'

export const BOT_BACKUP_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['bot', 'backup', 'list'],
    summary: "Show a bot's primary model, configured backup models, and live availability",
    usage: 'orca bot backup list --bot <name|id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'bot']
  },
  {
    path: ['bot', 'backup', 'add'],
    summary: 'Add a backup model to a bot',
    usage:
      'orca bot backup add --bot <name|id> --agent <agent> [--model <model>] [--effort <effort>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'bot', 'agent', 'model', 'effort']
  },
  {
    path: ['bot', 'backup', 'remove'],
    summary: 'Remove a backup model by its 1-based position',
    usage: 'orca bot backup remove --bot <name|id> --index <n> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'bot', 'index']
  },
  {
    path: ['bot', 'backup', 'reorder'],
    summary: 'Move a backup model from one 1-based position to another',
    usage: 'orca bot backup reorder --bot <name|id> --from <n> --to <n> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'bot', 'from', 'to']
  },
  {
    path: ['bot', 'backup', 'mode'],
    summary: 'Set failover mode to automatic or ask-before-switching',
    usage: 'orca bot backup mode --bot <name|id> (--auto | --ask) [--json]',
    booleanFlags: ['auto', 'ask'],
    allowedFlags: [...GLOBAL_FLAGS, 'bot', 'auto', 'ask']
  },
  {
    path: ['bot', 'backup', 'clear'],
    summary: 'Remove all configured backup models from a bot',
    usage: 'orca bot backup clear --bot <name|id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'bot']
  },
  {
    path: ['bot', 'backup', 'return'],
    summary: 'Return a bot currently running on a backup back to its primary model',
    usage: 'orca bot backup return --bot <name|id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'bot']
  }
]
