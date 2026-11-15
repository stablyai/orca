import { WorktreeAdopt } from '../../../../../shared/rpc-contract/workspaces/worktree-adopt-params'
import { defineMethod } from '../../core'
export const WORKTREE_ADOPT_METHOD = defineMethod({
  name: 'worktree.adopt',
  permission: 'workspace',
  params: WorktreeAdopt,
  handler: async (params, { runtime }) =>
    runtime.adoptManagedExternalWorktree(params.path, params.parentWorktree)
})
