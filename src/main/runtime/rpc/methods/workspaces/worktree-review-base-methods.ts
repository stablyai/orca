import {
  WorktreeResolveGiteaPrBase,
  WorktreeResolveMrBase,
  WorktreeResolvePrBase
} from '../../../../../shared/rpc-contract/workspaces/worktree-params'
import { defineMethod } from '../../core'

export const WORKTREE_REVIEW_BASE_METHODS = [
  defineMethod({
    name: 'worktree.resolvePrBase',
    permission: 'workspace',
    params: WorktreeResolvePrBase,
    handler: async (params, { runtime }) =>
      runtime.resolveManagedPrBase({
        repoSelector: params.repo,
        prNumber: params.prNumber,
        headRefName: params.headRefName,
        baseRefName: params.baseRefName,
        isCrossRepository: params.isCrossRepository,
        wakeWslDistro: params.wakeWslDistro
      })
  }),
  defineMethod({
    name: 'worktree.resolveGiteaPrBase',
    permission: 'workspace',
    params: WorktreeResolveGiteaPrBase,
    handler: async (params, { runtime }) =>
      runtime.resolveManagedGiteaPrBase({
        repoSelector: params.repo,
        prNumber: params.prNumber,
        headRefName: params.headRefName,
        baseRefName: params.baseRefName,
        isCrossRepository: params.isCrossRepository,
        wakeWslDistro: params.wakeWslDistro
      })
  }),
  defineMethod({
    name: 'worktree.resolveMrBase',
    permission: 'workspace',
    params: WorktreeResolveMrBase,
    handler: async (params, { runtime }) =>
      runtime.resolveManagedMrBase({
        repoSelector: params.repo,
        mrIid: params.mrIid,
        sourceBranch: params.sourceBranch,
        targetBranch: params.targetBranch,
        isCrossRepository: params.isCrossRepository,
        wakeWslDistro: params.wakeWslDistro
      })
  })
]
