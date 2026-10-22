import { WorktreeSelector } from '../../../../shared/rpc-contract/worktree-params'
import { queueWorktreeSleep } from '../../workspaces/workspace-lifecycle-commands'
import { defineMethod } from '../core'

export const WORKTREE_SLEEP_METHOD = defineMethod({
  name: 'worktree.sleep',
  permission: 'workspace',
  params: WorktreeSelector,
  handler: async (params, { runtime }) => queueWorktreeSleep(runtime, params.worktree)
})
