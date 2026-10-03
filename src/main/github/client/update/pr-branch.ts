import { acquire, ghExecFileAsync, release, type LocalGitExecOptions } from '../../gh-utils'
import { resolveGitHubRepoExecution, type GitHubApiRepository } from '../../github-api-repository'

/** Merge the base into the displayed PR head without modifying the local checkout. */
export async function updatePRBranch(
  repoPath: string,
  prNumber: number,
  expectedHeadSha: string,
  connectionId?: string | null,
  prRepo?: GitHubApiRepository | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!Number.isInteger(prNumber) || prNumber < 1 || !/^[a-f0-9]{40}$/i.test(expectedHeadSha)) {
    return { ok: false, error: 'Refresh the pull request before updating its branch.' }
  }
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
      [
        'api',
        '--method',
        'PUT',
        `repos/${ownerRepo.owner}/${ownerRepo.repo}/pulls/${prNumber}/update-branch`,
        '-f',
        `expected_head_sha=${expectedHeadSha}`
      ],
      ghOptions
    )
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    release()
  }
}
