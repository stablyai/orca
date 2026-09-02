import type { GitHubIssueUpdate } from '../../shared/issue-mutation-types'
import type { LocalGitExecOptions } from './gh-utils'
import { getIssueGitHubApiRepository, resolveGitHubRepoExecution } from './github-api-repository'
import { acquire, classifyGhError, ghExecFileAsync, release } from './gh-utils'

/**
 * Update an existing GitHub issue. Fans out to separate gh commands for
 * state changes vs field edits since `gh issue edit` does not support state.
 *
 * Why this path doesn't take a preference (mirrors `getIssue`): mutations
 * target an issue number already bound to a worktree / linked elsewhere in
 * the UI. Routing an update through the live per-repo preference would let
 * a user open upstream#N, toggle the selector to origin, save, and silently
 * write to origin#N — a different issue (or 404). That is the exact
 * silent-source-switch class of wrongness #1186 / the parent design doc
 * guard against. List and create paths honor preference; mutations stay on
 * the heuristic `getIssueOwnerRepo`.
 */
export async function updateIssue(
  repoPath: string,
  issueNumber: number,
  updates: GitHubIssueUpdate,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { ownerRepo, ghOptions } = await resolveGitHubRepoExecution(
    repoPath,
    () => getIssueGitHubApiRepository(repoPath, connectionId, localGitOptions),
    connectionId,
    localGitOptions
  )
  if (!ownerRepo) {
    return { ok: false, error: 'Could not resolve GitHub owner/repo for this repository' }
  }

  const repo = `${ownerRepo.owner}/${ownerRepo.repo}`
  const errors: string[] = []

  // State change requires a separate command
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
      const stderr = err instanceof Error ? err.message : String(err)
      // Treat "already closed/open" as a no-op
      if (!stderr.toLowerCase().includes('already')) {
        errors.push(classifyGhError(stderr).message)
      }
    } finally {
      release()
    }
  }

  if (updates.body !== undefined) {
    await acquire()
    try {
      await ghExecFileAsync(
        [
          'api',
          '-X',
          'PATCH',
          `repos/${ownerRepo.owner}/${ownerRepo.repo}/issues/${issueNumber}`,
          '--raw-field',
          `body=${updates.body}`
        ],
        ghOptions
      )
    } catch (err) {
      const stderr = err instanceof Error ? err.message : String(err)
      errors.push(classifyGhError(stderr).message)
    } finally {
      release()
    }
  }

  // Field edits (labels, assignees, title) via gh issue edit
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
      errors.push(classifyGhError(stderr).message)
    } finally {
      release()
    }
  }

  if (errors.length > 0) {
    return { ok: false, error: errors.join('; ') }
  }
  return { ok: true }
}
