import { invalidateReviewLookupsAfterPRMutation } from '../../pull-requests/refresh/pr-mutation-review-invalidation'
import { acquire, release } from '../../execution/github-operation-slots'
import { classifyPullRequestUpdateError } from '../../api/gh-error-classification'
import { ghExecFileAsync } from '../../../git/command-runner/hosted-cli/gh-exec-file'
import type { LocalGitExecOptions } from '../../repositories/github-repository-identity'
import { resolveGitHubRepoExecution } from '../../repositories/github-api-repository'
import type { GitHubRepositoryIdentity as GitHubApiRepository } from '../../../../shared/github/repositories/repository-identity'
import { codeHostFailure, classifiedFailure } from '../../../../shared/code-host-failure-copy'

export function markPRReadyForReview(
  repoPath: string,
  prNumber: number,
  connectionId?: string | null,
  prRepo?: GitHubApiRepository | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<{ ok: true } | { ok: false; error: string }> {
  return setPRReadyState(repoPath, prNumber, true, connectionId, prRepo, localGitOptions)
}

// `gh pr ready --undo` turns an open pull request back into a draft.
export function markPRDraft(
  repoPath: string,
  prNumber: number,
  connectionId?: string | null,
  prRepo?: GitHubApiRepository | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<{ ok: true } | { ok: false; error: string }> {
  return setPRReadyState(repoPath, prNumber, false, connectionId, prRepo, localGitOptions)
}

async function setPRReadyState(
  repoPath: string,
  prNumber: number,
  ready: boolean,
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
      [
        'pr',
        'ready',
        String(prNumber),
        '--repo',
        `${ownerRepo.owner}/${ownerRepo.repo}`,
        ...(ready ? [] : ['--undo'])
      ],
      ghOptions
    )
    return { ok: true }
  } catch (err) {
    const message =
      err instanceof Error ? err.message : typeof err === 'string' ? err : 'Unknown error'
    return classifiedFailure(classifyPullRequestUpdateError(message))
  } finally {
    invalidateReviewLookupsAfterPRMutation(repoPath, connectionId)
    release()
  }
}
