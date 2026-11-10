import { GIT_REVERT_CONFLICT_CLIENT_CAPABILITY } from '../../../../../../shared/git/commands/git-commit-action'
import type { GitConflictOperation } from '../../../../../../shared/git/status/git-status-types'
import {
  GitStatusParams,
  GitSubmoduleStatus,
  WorktreeSelector
} from '../../../../../../shared/rpc-contract/git-params'
import { defineMethod } from '../../../core'

function projectConflictOperation(
  operation: GitConflictOperation,
  capabilities?: readonly string[]
): GitConflictOperation {
  return operation === 'revert' && !capabilities?.includes(GIT_REVERT_CONFLICT_CLIENT_CAPABILITY)
    ? 'unknown'
    : operation
}

export const GIT_STATUS_METHODS = [
  defineMethod({
    name: 'git.submoduleStatus',
    permission: 'workspace',
    params: GitSubmoduleStatus,
    handler: async (params, { runtime, clientCapabilities }) => {
      const status = await runtime.getRuntimeGitSubmoduleStatus(
        params.worktree,
        params.submodulePath,
        params.area
      )
      return {
        ...status,
        conflictOperation: projectConflictOperation(status.conflictOperation, clientCapabilities)
      }
    }
  }),
  defineMethod({
    name: 'git.status',
    permission: 'workspace',
    params: GitStatusParams,
    handler: async (params, { runtime, signal, clientCapabilities }) => {
      const options =
        params.includeIgnored === undefined &&
        params.includeLineStats === undefined &&
        params.bypassEffectiveUpstreamNegativeCache === undefined &&
        params.reuseLineStats === undefined &&
        params.branchLineTotalMergeBase === undefined &&
        params.admissionTier === undefined &&
        signal === undefined
          ? undefined
          : {
              ...(params.includeIgnored === undefined
                ? {}
                : { includeIgnored: params.includeIgnored }),
              ...(params.includeLineStats === undefined
                ? {}
                : { includeLineStats: params.includeLineStats }),
              ...(params.bypassEffectiveUpstreamNegativeCache === true
                ? { bypassEffectiveUpstreamNegativeCache: true }
                : {}),
              ...(params.reuseLineStats === true ? { reuseLineStats: true } : {}),
              ...(params.branchLineTotalMergeBase === undefined
                ? {}
                : { branchLineTotalMergeBase: params.branchLineTotalMergeBase }),
              admissionTier: params.admissionTier ?? 'status',
              ...(signal ? { signal } : {})
            }
      const status = await (options === undefined
        ? runtime.getRuntimeGitStatus(params.worktree, { admissionTier: 'status' })
        : runtime.getRuntimeGitStatus(params.worktree, options))
      return {
        ...status,
        conflictOperation: projectConflictOperation(status.conflictOperation, clientCapabilities)
      }
    }
  }),
  defineMethod({
    name: 'git.conflictOperation',
    permission: 'workspace',
    params: WorktreeSelector,
    handler: async (params, { runtime, clientCapabilities }) =>
      projectConflictOperation(
        await runtime.getRuntimeGitConflictOperation(params.worktree),
        clientCapabilities
      )
  })
]
