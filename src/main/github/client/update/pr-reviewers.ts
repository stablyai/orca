import { invalidateReviewLookupsAfterPRMutation } from '../../pr-mutation-review-invalidation'
import { ghExecFileAsync, acquire, release, type LocalGitExecOptions } from '../../gh-utils'
import { resolveGitHubRepoExecution, type GitHubApiRepository } from '../../github-api-repository'
import { codeHostFailure } from '../../../../shared/code-host-failure-copy'

function reviewerUpdateArgs(
  repository: GitHubApiRepository,
  prNumber: number,
  logins: string[],
  operation: 'add' | 'remove'
): string[] {
  if (logins.every((login) => /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(login))) {
    return [
      'api',
      '-X',
      operation === 'add' ? 'POST' : 'DELETE',
      `repos/${repository.owner}/${repository.repo}/pulls/${prNumber}/requested_reviewers`,
      ...logins.flatMap((login) => ['--raw-field', `reviewers[]=${login}`])
    ]
  }
  return [
    'pr',
    'edit',
    String(prNumber),
    operation === 'add' ? '--add-reviewer' : '--remove-reviewer',
    logins.join(','),
    '--repo',
    `${repository.owner}/${repository.repo}`
  ]
}

export async function requestPRReviewers(
  repoPath: string,
  prNumber: number,
  reviewers: string[],
  connectionId?: string | null,
  prRepo?: GitHubApiRepository | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<{ ok: true } | { ok: false; error: string }> {
  const logins = reviewers.map((reviewer) => reviewer.trim()).filter(Boolean)
  if (logins.length === 0) {
    return codeHostFailure('github.reviewerRequired')
  }
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
    const args = reviewerUpdateArgs(ownerRepo, prNumber, logins, 'add')
    await ghExecFileAsync(args, {
      ...ghOptions,
      env: { ...process.env, GH_PROMPT_DISABLED: '1' }
    })
    invalidateReviewLookupsAfterPRMutation(repoPath, connectionId)
    return { ok: true }
  } catch (err) {
    const message =
      err instanceof Error ? err.message : typeof err === 'string' ? err : 'Unknown error'
    return { ok: false, error: message }
  } finally {
    release()
  }
}

export async function removePRReviewers(
  repoPath: string,
  prNumber: number,
  reviewers: string[],
  connectionId?: string | null,
  prRepo?: GitHubApiRepository | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<{ ok: true } | { ok: false; error: string }> {
  const logins = reviewers.map((reviewer) => reviewer.trim()).filter(Boolean)
  if (logins.length === 0) {
    return codeHostFailure('github.reviewerRequired')
  }
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
    const args = reviewerUpdateArgs(ownerRepo, prNumber, logins, 'remove')
    await ghExecFileAsync(args, {
      ...ghOptions,
      env: { ...process.env, GH_PROMPT_DISABLED: '1' }
    })
    invalidateReviewLookupsAfterPRMutation(repoPath, connectionId)
    return { ok: true }
  } catch (err) {
    const message =
      err instanceof Error ? err.message : typeof err === 'string' ? err : 'Unknown error'
    return { ok: false, error: message }
  } finally {
    release()
  }
}
