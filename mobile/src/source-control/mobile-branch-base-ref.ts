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
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  if (!repoId) {
    return null
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
  const upstreamCompareBaseRef = compare
    ? resolveSourceControlCompareBaseRef({
        enabled: compare.compareAgainstUpstream,
        worktreeBaseRef,
        repoBaseRef,
        upstreamName: compare.upstreamName,
        fallbackBaseRef: null
      })
    : null
  const pinnedBaseRef =
    upstreamCompareBaseRef ?? resolveSourceControlBaseRef({ worktreeBaseRef, repoBaseRef })
  if (pinnedBaseRef) {
    return pinnedBaseRef
  }

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
