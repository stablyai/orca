import type { GitHubPullRequestStateUpdate } from '../../../../shared/issue-mutation-types'
import {
  ghExecFileAsync,
  acquire,
  release,
  classifyPullRequestUpdateError,
  type LocalGitExecOptions
} from '../../gh-utils'
import { resolveGitHubRepoExecution, type GitHubApiRepository } from '../../github-api-repository'
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
    return { ok: false, error: 'Could not resolve GitHub owner/repo for this repository' }
  }

  await acquire()
  try {
    const cmd = updates.state === 'closed' ? 'close' : 'reopen'
    // Why: gh's PR commands use GitHub's supported reopen flow; REST state PATCH can 422 on reopen.
    await ghExecFileAsync(
      ['pr', cmd, String(prNumber), '--repo', `${ownerRepo.owner}/${ownerRepo.repo}`],
      {
        ...ghOptions
      }
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
