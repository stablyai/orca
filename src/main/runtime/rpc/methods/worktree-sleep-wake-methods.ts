import { WorktreeSelector } from '../../../../shared/rpc-contract/worktree-params'
import { defineMethod } from '../core'
import { WORKTREE_SLEEP_METHOD } from './worktree-sleep-method'

export const WORKTREE_SLEEP_WAKE_METHODS = [
  WORKTREE_SLEEP_METHOD,
  // Why: the background wake mobile activation uses, opened to every caller so a
  // CLI can resume slept agents without moving the desktop to the workspace.
  defineMethod({
    name: 'worktree.wake',
    permission: 'workspace',
    params: WorktreeSelector,
    handler: async (params, { runtime }) => runtime.wakeManagedWorktree(params.worktree)
  })
]
