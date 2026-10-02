import { preferRemoteTrackingCompareBase } from '../../../src/shared/worktree/base-ref'
import { refusedRpcMessageOrFallback } from '../transport/rpc-refusal-message'
import { isMobileGitUnavailableReply } from './mobile-git-status'
import { repoBaseRefListRead, repoDefaultBaseRefRead } from './mobile-repo-base-ref-operations'
import type { RpcOperationSender } from '../transport/rpc-operation-sender'
import { worktreeSummaryRead } from './mobile-worktree-metadata-operations'

function getRepoIdFromMobileWorktreeId(id: string): string {
  const separatorIdx = id.indexOf('::')
  return separatorIdx === -1 ? id : id.slice(0, separatorIdx)
}

export async function resolveMobileBranchCompareBaseRef(
  client: RpcOperationSender,
  worktreeId: string
): Promise<string | null> {
  const repoId = getRepoIdFromMobileWorktreeId(worktreeId)
  if (!repoId) {
    return null
  }

  const [worktreeReply, repoReply] = await Promise.all([
    worktreeSummaryRead.request(client, { worktree: `id:${worktreeId}` }).catch(() => null),
    repoBaseRefListRead.request(client).catch(() => null)
  ])
  const worktreeSummary = worktreeReply && worktreeSummaryRead.interpret(worktreeReply)
  const repos = repoReply && repoBaseRefListRead.interpret(repoReply)
  const worktreeBaseRef = worktreeSummary?.accepted
    ? worktreeSummary.value?.baseRef?.trim() || null
    : null
  const repo = repos?.accepted
    ? repos.value.find((candidate) => candidate.id === repoId)
    : undefined
  const repoBaseRef = repo?.worktreeBaseRef?.trim() || null
  let remoteCandidate = repoBaseRef
  if (!repoBaseRef) {
    const defaultReply = await repoDefaultBaseRefRead.request(client, { repo: `id:${repoId}` })
    // Why the raw refusal: a host that does not offer git to mobile is a capability gap to degrade
    // on, not an error to surface, and no acceptance policy carries the code and message through.
    if (isMobileGitUnavailableReply(defaultReply)) {
      return preferRemoteTrackingCompareBase(worktreeBaseRef, null)
    }
    try {
      remoteCandidate = repoDefaultBaseRefRead.interpret(defaultReply)
    } catch (error) {
      throw new Error(refusedRpcMessageOrFallback(error, 'Unable to resolve branch base'))
    }
  }
  return preferRemoteTrackingCompareBase(worktreeBaseRef, remoteCandidate)
}
