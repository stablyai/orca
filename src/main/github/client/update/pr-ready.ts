import { invalidateReviewLookupsAfterPRMutation } from '../../pr-mutation-review-invalidation'
import {
  acquire,
  classifyPullRequestUpdateError,
  ghExecFileAsync,
  release,
  type LocalGitExecOptions
} from '../../gh-utils'
import { resolveGitHubRepoExecution, type GitHubApiRepository } from '../../github-api-repository'
import { codeHostFailure, classifiedFailure } from '../../../../shared/code-host-failure-copy'

export async function markPRReadyForReview(
  repoPath: string,
  prNumber: number,
  connectionId?: string | null,
  prRepo?: GitHubApiRepository | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { ownerRepo, ghOptions } = await resolveGitHubRepoExecution(
    repoPath,
    prRepo,
    connectionId,
    localGitOptions
  )
  if (!ownerRepo) {
    return codeHostFailure('github.repoUnresolved')
  }

  await acquire()
  try {
    await ghExecFileAsync(
      ['pr', 'ready', String(prNumber), '--repo', `${ownerRepo.owner}/${ownerRepo.repo}`],
      ghOptions
    )
    invalidateReviewLookupsAfterPRMutation(repoPath, connectionId)
    return { ok: true }
  } catch (err) {
    const message =
      err instanceof Error ? err.message : typeof err === 'string' ? err : 'Unknown error'
    return classifiedFailure(classifyPullRequestUpdateError(message))
  } finally {
    release()
  }
}
