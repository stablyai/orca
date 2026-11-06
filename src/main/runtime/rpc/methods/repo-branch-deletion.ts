import { defineMethod } from '../core'
import { StandaloneBranchDeletionError } from '../../../../shared/standalone-branch-deletion'
import { RepoDeleteBranch } from '../../../../shared/rpc-contract/repo-params'
import { hostQualifiedRepoSelector } from '../../workspaces/catalog/runtime-repo-selector'

export const REPO_BRANCH_DELETION_METHODS = [
  defineMethod({
    name: 'repo.deleteBranch',
    permission: 'workspace',
    params: RepoDeleteBranch,
    handler: async (params, { runtime }) => {
      try {
        return await runtime.deleteRepoBranch(
          hostQualifiedRepoSelector(params.repo, params.repoHostId),
          params
        )
      } catch (error) {
        if (error instanceof StandaloneBranchDeletionError) {
          throw error
        }
        throw new StandaloneBranchDeletionError(
          error instanceof Error ? error.message : String(error)
        )
      }
    }
  })
]
