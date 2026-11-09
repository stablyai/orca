import type { GitHubIssueUpdate } from '../../shared/issue-mutation-types'
import type { IssueSourcePreference } from '../../shared/repo-types'
import type { LocalGitExecOptions } from './gh-utils'
import {
  resolveGitHubRepoExecution,
  resolveIssueGitHubApiRepositorySource,
  type GitHubApiRepository
} from './github-api-repository'
import { acquire, classifyGhError, ghExecFileAsync, release } from './gh-utils'
import { codeHostFailure, combinedClassifiedFailure } from '../../shared/code-host-failure-copy'
import type { ClassifiedError } from '../../shared/classified-error'
import { githubBodyImageUrls, githubBodyMediaHeaders } from './body-image-urls'

export async function updateIssue(
  repoPath: string,
  issueNumber: number,
  updates: GitHubIssueUpdate,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {},
  preference?: IssueSourcePreference,
  ownerRepoOverride?: GitHubApiRepository | null
): Promise<{ ok: true; bodyImageUrls?: Record<string, string> } | { ok: false; error: string }> {
  const { ownerRepo, ghOptions } = await resolveGitHubRepoExecution(
    repoPath,
    ownerRepoOverride ??
      (async () =>
        (
          await resolveIssueGitHubApiRepositorySource(
            repoPath,
            preference,
            connectionId,
            localGitOptions
          )
        ).source),
    connectionId,
    localGitOptions
  )
  if (!ownerRepo) {
    return codeHostFailure('github.repoUnresolved')
  }

  const repo = `${ownerRepo.owner}/${ownerRepo.repo}`
  const errors: ClassifiedError[] = []
  let bodyImageUrls: Record<string, string> | undefined

  if (updates.state) {
    await acquire()
    try {
      if (updates.state === 'closed') {
        const closeArgs = ['issue', 'close', String(issueNumber), '--repo', repo]
        if (updates.stateReason === 'completed') {
          closeArgs.push('--reason', 'completed')
        } else if (updates.stateReason === 'not_planned') {
          closeArgs.push('--reason', 'not planned')
        } else if (updates.stateReason === 'duplicate' && updates.duplicateOf) {
          closeArgs.push('--duplicate-of', String(updates.duplicateOf))
        }
        await ghExecFileAsync(closeArgs, ghOptions)
      } else {
        await ghExecFileAsync(['issue', 'reopen', String(issueNumber), '--repo', repo], ghOptions)
      }
    } catch (err) {
      // Why: gh exits 0 when the issue is already in the target state, so any failure is real.
      const stderr = err instanceof Error ? err.message : String(err)
      errors.push(classifyGhError(stderr))
    } finally {
      release()
    }
  }

  if (updates.body !== undefined) {
    await acquire()
    try {
      const { stdout } = await ghExecFileAsync(
        [
          'api',
          '-X',
          'PATCH',
          `repos/${ownerRepo.owner}/${ownerRepo.repo}/issues/${issueNumber}`,
          ...githubBodyMediaHeaders(updates.body),
          '--input',
          '-'
        ],
        { ...ghOptions, stdin: JSON.stringify({ body: updates.body }) }
      )
      try {
        const response: { body?: string; body_html?: string } = JSON.parse(stdout)
        if (response?.body === updates.body) {
          bodyImageUrls = githubBodyImageUrls(response.body, response.body_html)
        }
      } catch {
        // Optional display data cannot turn an accepted edit into a failed write.
      }
    } catch (err) {
      const stderr = err instanceof Error ? err.message : String(err)
      errors.push(classifyGhError(stderr))
    } finally {
      release()
    }
  }

  const editArgs: string[] = ['issue', 'edit', String(issueNumber), '--repo', repo]
  let hasEditArgs = false

  if (updates.title) {
    editArgs.push('--title', updates.title)
    hasEditArgs = true
  }
  for (const label of updates.addLabels ?? []) {
    editArgs.push('--add-label', label)
    hasEditArgs = true
  }
  for (const label of updates.removeLabels ?? []) {
    editArgs.push('--remove-label', label)
    hasEditArgs = true
  }
  for (const assignee of updates.addAssignees ?? []) {
    editArgs.push('--add-assignee', assignee)
    hasEditArgs = true
  }
  for (const assignee of updates.removeAssignees ?? []) {
    editArgs.push('--remove-assignee', assignee)
    hasEditArgs = true
  }

  if (hasEditArgs) {
    await acquire()
    try {
      await ghExecFileAsync(editArgs, ghOptions)
    } catch (err) {
      const stderr = err instanceof Error ? err.message : String(err)
      errors.push(classifyGhError(stderr))
    } finally {
      release()
    }
  }

  if (errors.length > 0) {
    return combinedClassifiedFailure(errors)
  }
  return { ok: true, bodyImageUrls }
}
