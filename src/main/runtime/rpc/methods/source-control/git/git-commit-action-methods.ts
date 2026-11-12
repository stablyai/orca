import { defineMethod } from '../../../core'
import {
  GitCommitAction,
  GitSequencer,
  GitCreateBranch
} from '../../../../../../shared/rpc-contract/git-params'

export const GIT_COMMIT_ACTION_METHODS = [
  defineMethod({
    name: 'git.createBranch',
    permission: 'workspace',
    params: GitCreateBranch,
    handler: async (params, { runtime }) =>
      runtime.createRuntimeGitBranch(params.worktree, params.name, params.startPoint)
  }),
  defineMethod({
    name: 'git.sequencerContinue',
    permission: 'workspace',
    params: GitSequencer,
    handler: async (params, { runtime }) =>
      runtime.sequencerContinueRuntimeGit(params.worktree, params.operation)
  }),
  defineMethod({
    name: 'git.sequencerAbort',
    permission: 'workspace',
    params: GitSequencer,
    handler: async (params, { runtime }) =>
      runtime.sequencerAbortRuntimeGit(params.worktree, params.operation)
  }),
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
