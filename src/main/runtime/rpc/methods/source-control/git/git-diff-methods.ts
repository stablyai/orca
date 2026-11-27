import { defineMethod } from '../../../core'
import {
  remoteRpcContentBudget,
  remoteRpcResultExceedsContentBudget
} from '../../../../../../shared/remote-runtime/rpc/remote-rpc-content-budget'
import {
  GitBranchDiff,
  GitCommitDiff,
  GitBlame,
  GitDiff
} from '../../../../../../shared/rpc-contract/source-control/git-params'

// Only WebSocket callers set clientKind; local/in-process diffs retain uncapped fidelity.
function remoteDiffContentBudget(
  clientKind: 'mobile' | 'runtime' | undefined,
  requestId: string | undefined
): number | undefined {
  return clientKind && requestId ? remoteRpcContentBudget(requestId) : undefined
}

export const GIT_DIFF_METHODS = [
  defineMethod({
    name: 'git.diff',
    permission: 'workspace',
    params: GitDiff,
    handler: async (params, { runtime, clientKind, requestId }) =>
      runtime.getRuntimeGitDiff(
        params.worktree,
        params.filePath,
        params.staged,
        params.compareAgainstHead,
        remoteDiffContentBudget(clientKind, requestId),
        ...(params.oldPath ? ([params.oldPath] as const) : [])
      )
  }),
  defineMethod({
    name: 'git.branchDiff',
    permission: 'workspace',
    params: GitBranchDiff,
    handler: async (params, { runtime, clientKind, requestId }) =>
      runtime.getRuntimeGitBranchDiff(
        params.worktree,
        params.compare,
        params.filePath,
        params.oldPath,
        remoteDiffContentBudget(clientKind, requestId)
      )
  }),
  defineMethod({
    name: 'git.commitDiff',
    permission: 'workspace',
    params: GitCommitDiff,
    handler: async (params, { runtime, clientKind, requestId }) =>
      runtime.getRuntimeGitCommitDiff(
        params.worktree,
        {
          commitOid: params.commitOid,
          parentOid: params.parentOid,
          filePath: params.filePath,
          oldPath: params.oldPath
        },
        remoteDiffContentBudget(clientKind, requestId)
      )
  }),
  defineMethod({
    name: 'git.blame',
    permission: 'workspace',
    params: GitBlame,
    handler: async (params, { runtime, clientKind, requestId }) => {
      const result = await runtime.getRuntimeGitBlame(
        params.worktree,
        params.filePath,
        params.knownHeadOid
      )
      const budget = remoteDiffContentBudget(clientKind, requestId)
      // The reply carries the HEAD text; past the remote reply budget it would be refused anyway.
      return result.kind === 'ready' &&
        budget !== undefined &&
        remoteRpcResultExceedsContentBudget(result, budget, ['headText'])
        ? { kind: 'too-large' as const }
        : result
    }
  })
]
