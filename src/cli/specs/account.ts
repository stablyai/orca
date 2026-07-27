import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const ACCOUNT_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['account', 'list'],
    summary: 'List managed Claude accounts',
    usage: 'orca account list [--json]',
    allowedFlags: [...GLOBAL_FLAGS]
  },
  {
    path: ['account', 'use'],
    summary: 'Select a managed Claude account',
    usage: 'orca account use --account <id|email|null> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'account']
  }
]
