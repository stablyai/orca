import type { RpcMethod } from '../core'
import { STATUS_METHODS } from './status'
import { REPO_METHODS } from './repo'
import { WORKTREE_METHODS } from './worktree'
import { TERMINAL_METHODS } from './terminal'
import { BROWSER_CORE_METHODS } from './browser-core'
import { BROWSER_EXTRA_METHODS } from './browser-extras'

// Why: a flat manifest keeps registration order explicit and provides one
// grep-point for "what methods does the RPC server expose?" — useful when
// auditing the security boundary or wiring new CLI commands.
export const ALL_RPC_METHODS: readonly RpcMethod[] = [
  ...STATUS_METHODS,
  ...REPO_METHODS,
  ...WORKTREE_METHODS,
  ...TERMINAL_METHODS,
  ...BROWSER_CORE_METHODS,
  ...BROWSER_EXTRA_METHODS
]
