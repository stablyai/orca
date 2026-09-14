import {
  acquire,
  classifyPullRequestUpdateError,
  ghExecFileAsync,
  release,
  type LocalGitExecOptions
} from '../../gh-utils'
import { resolveGitHubRepoExecution, type GitHubApiRepository } from '../../github-api-repository'

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
    return { ok: false, error: 'Could not resolve GitHub owner/repo for this repository' }
  }

  await acquire()
  try {
    await ghExecFileAsync(
      ['pr', 'ready', String(prNumber), '--repo', `${ownerRepo.owner}/${ownerRepo.repo}`],
      ghOptions
    )
    return { ok: true }
  } catch (err) {
    const message =
      err instanceof Error ? err.message : typeof err === 'string' ? err : 'Unknown error'
    return { ok: false, error: classifyPullRequestUpdateError(message).message }
  } finally {
    release()
  }
}
