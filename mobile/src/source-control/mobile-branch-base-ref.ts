import { refusedRpcMessageOrFallback } from '../transport/rpc-refusal-message'
import { getRepoIdFromWorktreeId } from '../../../src/shared/worktree/id'
import { isMobileGitUnavailableReply } from './mobile-git-status'
import { repoBaseRefListRead, repoDefaultBaseRefRead } from './mobile-repo-base-ref-operations'
import type { RpcOperationSender } from '../transport/rpc-operation-sender'
import { worktreeSummaryRead } from './mobile-worktree-metadata-operations'
import {
  resolveSourceControlBaseRef,
  resolveSourceControlCompareBaseRef
} from '../../../src/shared/source-control-base-ref-resolution'

// The branch compare also honours desktop's compare-against-upstream setting.
export type MobileBranchCompareTarget = {
  compareAgainstUpstream: boolean
  upstreamName?: string | null
}

export async function resolveMobileBranchCompareBaseRef(
  client: RpcOperationSender,
  worktreeId: string,
  compare?: MobileBranchCompareTarget
): Promise<string | null> {
  return (await resolveMobileBranchBaseRefs(client, worktreeId, compare)).compareBaseRef
}

export type MobileBranchBaseRefs = {
  compareBaseRef: string | null
  // Never rejects; reads the repo default only when an upstream compare skipped it.
  readEffectiveBaseRef: () => Promise<string | null>
}

// Desktop's pair: the compare base can be the upstream, while PRs and rebases target the effective base.
export async function resolveMobileBranchBaseRefs(
  client: RpcOperationSender,
  worktreeId: string,
  compare?: MobileBranchCompareTarget
): Promise<MobileBranchBaseRefs> {
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  if (!repoId) {
    return { compareBaseRef: null, readEffectiveBaseRef: async () => null }
  }

  const [worktreeReply, repoReply] = await Promise.all([
    worktreeSummaryRead.request(client, { worktree: `id:${worktreeId}` }).catch(() => null),
    repoBaseRefListRead.request(client).catch(() => null)
  ])
  const worktreeSummary = worktreeReply && worktreeSummaryRead.interpret(worktreeReply)
  const worktreeBaseRef = worktreeSummary?.accepted
    ? (worktreeSummary.value?.baseRef ?? null)
    : null
  const repos = repoReply && repoBaseRefListRead.interpret(repoReply)
  const repoBaseRef = repos?.accepted
    ? (repos.value.find((candidate) => candidate.id === repoId)?.worktreeBaseRef ?? null)
    : null

  // Desktop's resolution; the default is fetched only when nothing is pinned.
  const pinnedBaseRef = resolveSourceControlBaseRef({ worktreeBaseRef, repoBaseRef })
  if (pinnedBaseRef) {
    return { compareBaseRef: pinnedBaseRef, readEffectiveBaseRef: async () => pinnedBaseRef }
  }
  const upstreamCompareBaseRef = resolveSourceControlCompareBaseRef({
    enabled: compare?.compareAgainstUpstream === true,
    worktreeBaseRef,
    repoBaseRef,
    upstreamName: compare?.upstreamName,
    fallbackBaseRef: null
  })
  if (upstreamCompareBaseRef) {
    return {
      compareBaseRef: upstreamCompareBaseRef,
      readEffectiveBaseRef: () => readDefaultBaseRef(client, repoId).catch(() => null)
    }
  }
  const defaultBaseRef = await readDefaultBaseRef(client, repoId)
  return { compareBaseRef: defaultBaseRef, readEffectiveBaseRef: async () => defaultBaseRef }
}

async function readDefaultBaseRef(
  client: RpcOperationSender,
  repoId: string
): Promise<string | null> {
  const defaultReply = await repoDefaultBaseRefRead.request(client, { repo: `id:${repoId}` })
  // Inspect the raw refusal to distinguish a missing git capability from an actionable error.
  if (isMobileGitUnavailableReply(defaultReply)) {
    return null
  }
  try {
    return repoDefaultBaseRefRead.interpret(defaultReply)
  } catch (error) {
    throw new Error(refusedRpcMessageOrFallback(error, 'Unable to resolve branch base'))
  }
}
