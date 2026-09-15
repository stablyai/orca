import { refusedRpcMessageOrFallback } from '../transport/rpc-refusal-message'
import { isMobileGitUnavailableReply } from './mobile-git-status'
import { repoBaseRefListRead, repoDefaultBaseRefRead } from './mobile-repo-base-ref-operations'
import type { MobileSourceControlRpcSender } from './mobile-source-control-rpc-sender'
import { worktreeSummaryRead } from './mobile-worktree-metadata-operations'

function getRepoIdFromMobileWorktreeId(id: string): string {
  const separatorIdx = id.indexOf('::')

  return separatorIdx === -1 ? id : id.slice(0, separatorIdx)
}

export async function resolveMobileBranchCompareBaseRef(
  client: MobileSourceControlRpcSender,
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

  if (worktreeSummary?.accepted) {
    const worktreeBaseRef = worktreeSummary.value?.baseRef?.trim() || null

    if (worktreeBaseRef) {
      return worktreeBaseRef
    }
  }

  const repos = repoReply && repoBaseRefListRead.interpret(repoReply)

  if (repos?.accepted) {
    const repo = repos.value.find((candidate) => candidate.id === repoId)
    const repoBaseRef = repo?.worktreeBaseRef?.trim() || null

    if (repoBaseRef) {
      return repoBaseRef
    }
  }

  const defaultReply = await repoDefaultBaseRefRead.request(client, { repo: `id:${repoId}` })

  // Why the raw refusal: a host that does not offer git to mobile is a capability gap to degrade
  // on, not an error to surface, and no acceptance policy carries the code and message through.
  if (isMobileGitUnavailableReply(defaultReply)) {
    return null
  }

  try {
    return repoDefaultBaseRefRead.interpret(defaultReply)
  } catch (error) {
    throw new Error(refusedRpcMessageOrFallback(error, 'Unable to resolve branch base'))
  }
}
