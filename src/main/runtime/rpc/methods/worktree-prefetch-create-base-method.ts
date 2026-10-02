import { WorktreePrefetchCreateBase } from '../../../../shared/rpc-contract/worktree-create-params'
import { defineMethod } from '../core'

export const WORKTREE_PREFETCH_CREATE_BASE_METHOD = defineMethod({
  name: 'worktree.prefetchCreateBase',
  permission: 'workspace',
  params: WorktreePrefetchCreateBase,
  handler: async (params, { runtime }) => {
    await runtime.prefetchManagedWorktreeCreateBase({
      repoSelector: params.repo,
      baseBranch: params.baseBranch
    })
    return null
  }
})
