import type { RpcClient } from '../transport/rpc-client'
import type { GitHubPrStartPoint } from '../../../src/shared/worktree/types'
import { worktreeMrBaseResolve, worktreePrBaseResolve } from './mobile-workspace-create-operations'
import type { ComposerBaseState } from './mobile-composer-source-types'

export type ComposerHostedBase = Pick<
  GitHubPrStartPoint,
  'baseBranch' | 'compareBaseRef' | 'pushTarget' | 'branchNameOverride' | 'maintainerCanModify'
>

export function toComposerBaseState(result: ComposerHostedBase): ComposerBaseState {
  return {
    baseBranch: result.baseBranch,
    compareBaseRef: result.compareBaseRef,
    pushTarget: result.pushTarget,
    branchNameOverride: result.branchNameOverride
  }
}

// Provider failure arrives as a soft error payload, not an RPC refusal.
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

export function resolveComposerHostedItemBase(args: {
  client: RpcClient
  repoId: string
  provider: 'github' | 'gitlab'
  type: 'issue' | 'pr' | 'mr'
  number: number
  branchName?: string
  baseRefName?: string
  isCrossRepository?: boolean
}): Promise<ComposerHostedBase> | null {
  const { client, repoId, provider, type, number, branchName, baseRefName, isCrossRepository } =
    args
  const crossRepo = isCrossRepository === undefined ? {} : { isCrossRepository }
  if (provider === 'github') {
    return type === 'pr'
      ? resolveComposerPrBase({
          client,
          repoId,
          prNumber: number,
          ...(branchName ? { headRefName: branchName } : {}),
          ...(baseRefName ? { baseRefName } : {}),
          ...crossRepo
        })
      : null
  }
  return type === 'mr'
    ? resolveComposerMrBase({
        client,
        repoId,
        mrIid: number,
        ...(branchName ? { sourceBranch: branchName } : {}),
        ...(baseRefName ? { targetBranch: baseRefName } : {}),
        ...crossRepo
      })
    : null
}

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
