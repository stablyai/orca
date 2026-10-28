import { WorktreeForceDeleteBranch } from '../../../../shared/rpc-contract/worktree-params'
import { defineMethod } from '../core'
import { resolvePairedCallerHostId } from './paired-caller-host-id'

export const WORKTREE_FORCE_DELETE_BRANCH_METHOD = defineMethod({
  name: 'worktree.forceDeleteBranch',
  permission: 'workspace',
  params: WorktreeForceDeleteBranch,
  handler: async (params, { runtime }) => {
    const hostId = resolvePairedCallerHostId(
      () => runtime.listRepos(),
      params.worktree,
      params.hostId
    )
    return hostId
      ? runtime.forceDeletePreservedBranch(
          params.worktree,
          params.branchName,
          params.expectedHead,
          hostId
        )
      : runtime.forceDeletePreservedBranch(params.worktree, params.branchName, params.expectedHead)
  }
})
