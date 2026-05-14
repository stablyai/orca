import type { RpcAnyMethod } from '../core'
import { STATUS_METHODS } from './status'
import { REPO_METHODS } from './repo'
import { WORKTREE_METHODS } from './worktree'
import { TERMINAL_METHODS } from './terminal'
import { BROWSER_CORE_METHODS } from './browser-core'
import { BROWSER_EXTRA_METHODS } from './browser-extras'
import { ORCHESTRATION_METHODS } from './orchestration'
import { NOTIFICATION_METHODS } from './notifications'
import { STATS_METHODS } from './stats'
import { ACCOUNT_METHODS } from './accounts'
import { COMPUTER_METHODS } from './computer'
import { SESSION_TAB_METHODS } from './session-tabs'
import { FILE_METHODS } from './files'
import { NOTE_METHODS } from './notes'

// Why: a flat manifest keeps registration order explicit and provides one
// grep-point for "what methods does the RPC server expose?" — useful when
// auditing the security boundary or wiring new CLI commands.
export const ALL_RPC_METHODS: readonly RpcAnyMethod[] = [
  ...STATUS_METHODS,
  ...REPO_METHODS,
  ...WORKTREE_METHODS,
  ...TERMINAL_METHODS,
  ...BROWSER_CORE_METHODS,
  ...BROWSER_EXTRA_METHODS,
  ...ORCHESTRATION_METHODS,
  ...NOTIFICATION_METHODS,
  ...STATS_METHODS,
  ...ACCOUNT_METHODS,
  ...COMPUTER_METHODS,
  ...SESSION_TAB_METHODS,
  ...FILE_METHODS,
  ...NOTE_METHODS
]
