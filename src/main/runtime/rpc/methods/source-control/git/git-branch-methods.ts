import { defineMethod } from '../../../core'
import { GitSwitchBranch } from '../../../../../../shared/rpc-contract/source-control/git-params'

export const GIT_BRANCH_METHODS = [
  defineMethod({
    name: 'git.switchBranch',
    permission: 'workspace',
    params: GitSwitchBranch,
    handler: async (params, { runtime }) =>
      runtime.switchRuntimeGitBranch(params.worktree, params.target)
  })
]
