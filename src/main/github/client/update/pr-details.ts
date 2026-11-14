import { invalidateReviewLookupsAfterPRMutation } from '../../pull-requests/refresh/pr-mutation-review-invalidation'
import { ghExecFileAsync } from '../../../git/command-runner/hosted-cli/gh-exec-file'
import { acquire, release } from '../../execution/github-operation-slots'
import { classifyPullRequestUpdateError } from '../../api/gh-error-classification'
import type { LocalGitExecOptions } from '../../repositories/github-repository-identity'
import {
  resolveGitHubRepoExecution,
  type GitHubRepoExecOptions
} from '../../repositories/github-api-repository'
import type { GitHubRepositoryIdentity as GitHubApiRepository } from '../../../../shared/github/repositories/repository-identity'
import { codeHostFailure, classifiedFailure } from '../../../../shared/code-host-failure-copy'

async function patchPullRequest(
  repository: GitHubApiRepository,
  prNumber: number,
  fields: string[],
  ghOptions: GitHubRepoExecOptions
): Promise<void> {
  await ghExecFileAsync(
    [
      'api',
      '-X',
      'PATCH',
      `repos/${repository.owner}/${repository.repo}/pulls/${prNumber}`,
      ...fields.flatMap((field) => ['--raw-field', field])
    ],
    ghOptions
  )
}

export async function updatePRTitle(
  repoPath: string,
  prNumber: number,
  title: string,
  connectionId?: string | null,
  prRepo?: GitHubApiRepository | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<boolean> {
  const { ownerRepo, ghOptions } = await resolveGitHubRepoExecution(
    repoPath,
    prRepo,
    connectionId,
    localGitOptions
  )
  if (!ownerRepo) {
    return false
  }
  await acquire()
  try {
    await patchPullRequest(ownerRepo, prNumber, [`title=${title}`], ghOptions)
    return true
  } catch (err) {
    console.warn('updatePRTitle failed:', err)
    return false
  } finally {
    invalidateReviewLookupsAfterPRMutation(repoPath, connectionId)
    release()
  }
}

export async function updatePRDetails(
  repoPath: string,
  prNumber: number,
  updates: { title?: string; body?: string },
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

  const fields: string[] = []
  if (updates.title !== undefined) {
    const title = updates.title.trim()
    if (!title) {
      return codeHostFailure('titleRequired')
    }
    fields.push(`title=${title}`)
  }
  if (updates.body !== undefined) {
    fields.push(`body=${updates.body}`)
  }
  if (fields.length === 0) {
    return { ok: true }
  }

  await acquire()
  try {
    await patchPullRequest(ownerRepo, prNumber, fields, ghOptions)
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
