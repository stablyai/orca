import { invalidateReviewLookupsAfterPRMutation } from '../../pr-mutation-review-invalidation'
import type { GitHubPullRequestStateUpdate } from '../../../../shared/issue-mutation-types'
import {
  ghExecFileAsync,
  acquire,
  release,
  classifyPullRequestUpdateError,
  type LocalGitExecOptions
} from '../../gh-utils'
import { resolveGitHubRepoExecution, type GitHubApiRepository } from '../../github-api-repository'
import { codeHostFailure, classifiedFailure } from '../../../../shared/code-host-failure-copy'
export async function updatePRState(
  repoPath: string,
  prNumber: number,
  updates: GitHubPullRequestStateUpdate,
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
    const cmd = updates.state === 'closed' ? 'close' : 'reopen'
    // Use GitHub's supported CLI reopen flow; REST state PATCH can reject reopening.
    await ghExecFileAsync(
      ['pr', cmd, String(prNumber), '--repo', `${ownerRepo.owner}/${ownerRepo.repo}`],
      {
        ...ghOptions
      }
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
