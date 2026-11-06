import { defineMethod } from '../core'
import { GitCommitAction } from '../../../../shared/rpc-contract/git-params'

export const GIT_COMMIT_ACTION_METHODS = [
  defineMethod({
    name: 'git.cherryPick',
    permission: 'workspace',
    params: GitCommitAction,
    handler: async (params, { runtime }) =>
      runtime.cherryPickRuntimeGit(params.worktree, params.commitId)
  }),
  defineMethod({
    name: 'git.revert',
    permission: 'workspace',
    params: GitCommitAction,
    handler: async (params, { runtime }) =>
      runtime.revertRuntimeGit(params.worktree, params.commitId)
  })
]
