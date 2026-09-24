import type { RpcClient } from '../transport/rpc-client'
import type { GitHubPrStartPoint } from '../../../src/shared/worktree/types'
import { worktreeMrBaseResolve, worktreePrBaseResolve } from './mobile-workspace-create-operations'

// The resolved start point for a linked PR/MR: the base branch to create from
// plus the optional review-compare ref, push target, and exact branch name.
export type ComposerHostedBase = Pick<
  GitHubPrStartPoint,
  'baseBranch' | 'compareBaseRef' | 'pushTarget' | 'branchNameOverride' | 'maintainerCanModify'
>

// Resolves a GitHub PR's base via worktree.resolvePrBase, mirroring desktop's
// select-time resolution. The runtime returns a soft { error } payload rather
// than an RPC error for provider failures.
export async function resolveComposerPrBase(args: {
  client: RpcClient
  repoId: string
  prNumber: number
  headRefName?: string
  baseRefName?: string
  isCrossRepository?: boolean
}): Promise<GitHubPrStartPoint> {
  const { client, repoId, prNumber, headRefName, baseRefName, isCrossRepository } = args
  const reply = await worktreePrBaseResolve.request(
    client,
    {
      repo: `id:${repoId}`,
      prNumber,
      ...(headRefName ? { headRefName } : {}),
      ...(baseRefName ? { baseRefName } : {}),
      ...(isCrossRepository !== undefined ? { isCrossRepository } : {})
    },
    { timeoutMs: 30_000 }
  )
  const result = worktreePrBaseResolve.interpret(reply)
  if ('error' in result) {
    throw new Error(result.error)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resolved arm requires `baseBranch`; `compareBaseRef`, `pushTarget`, `branchNameOverride` and `maintainerCanModify` are optional on GitHubPrStartPoint and stay optional here, and unknown members pass through to the create.
  return result as GitHubPrStartPoint
}

// Resolves a GitLab MR's base via worktree.resolveMrBase.
export async function resolveComposerMrBase(args: {
  client: RpcClient
  repoId: string
  mrIid: number
  sourceBranch?: string
  targetBranch?: string
  isCrossRepository?: boolean
}): Promise<ComposerHostedBase> {
  const { client, repoId, mrIid, sourceBranch, targetBranch, isCrossRepository } = args
  const reply = await worktreeMrBaseResolve.request(
    client,
    {
      repo: `id:${repoId}`,
      mrIid,
      ...(sourceBranch ? { sourceBranch } : {}),
      ...(targetBranch ? { targetBranch } : {}),
      ...(isCrossRepository !== undefined ? { isCrossRepository } : {})
    },
    { timeoutMs: 30_000 }
  )
  const result = worktreeMrBaseResolve.interpret(reply)
  if ('error' in result) {
    throw new Error(result.error)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: as the PR resolver above.
  return result as ComposerHostedBase
}
