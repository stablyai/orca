import type { GitLabIssueUpdate } from '../../shared/gitlab-types'
import type { IssueSourcePreference } from '../../shared/repo-types'
import {
  acquire,
  classifyGlabError,
  getGlabKnownHosts,
  glabExecFileAsync,
  glabHostnameArgs,
  glabRepoExecOptions,
  release,
  resolveIssueSource,
  type LocalGitExecOptions,
  type ProjectRef
} from './gl-utils'
import { encodedProject } from './project-path-encoding'

/**
 * Update an existing GitLab issue.
 *
 * Why: callers that list through a per-repo issue source preference must
 * mutate the same GitLab project, or identical IIDs on origin/upstream can
 * silently edit the wrong issue.
 */
export async function updateIssue(
  repoPath: string,
  issueNumber: number,
  updates: GitLabIssueUpdate,
  preference?: IssueSourcePreference,
  connectionId?: string | null,
  projectRefOverride?: ProjectRef | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<{ ok: true } | { ok: false; error: string }> {
  const projectRef =
    projectRefOverride ??
    (
      await resolveIssueSource(
        repoPath,
        preference,
        await getGlabKnownHosts(connectionId, localGitOptions),
        connectionId,
        localGitOptions
      )
    ).source
  if (!projectRef) {
    return {
      ok: false,
      error: 'Could not resolve GitLab project for this repository'
    }
  }

  const repoFlag = projectRef.path
  const errors: string[] = []

  // State change requires a separate command (parallel to github's split).
  if (updates.state) {
    await acquire()
    try {
      const cmd = updates.state === 'closed' ? 'close' : 'reopen'
      await glabExecFileAsync(
        [
          'issue',
          cmd,
          String(issueNumber),
          '-R',
          repoFlag,
          ...glabHostnameArgs(projectRef, connectionId)
        ],
        glabRepoExecOptions(repoPath, connectionId, localGitOptions)
      )
    } catch (err) {
      const stderr = err instanceof Error ? err.message : String(err)
      // Treat "already closed/reopened" as a no-op (matches gh path).
      if (!stderr.toLowerCase().includes('already')) {
        errors.push(classifyGlabError(stderr).message)
      }
    } finally {
      release()
    }
  }

  if (updates.body !== undefined) {
    await acquire()
    try {
      await glabExecFileAsync(
        [
          'api',
          ...glabHostnameArgs(projectRef, connectionId),
          '-X',
          'PUT',
          `projects/${encodedProject(repoFlag)}/issues/${issueNumber}`,
          '-f',
          `description=${updates.body}`
        ],
        glabRepoExecOptions(repoPath, connectionId, localGitOptions)
      )
    } catch (err) {
      const stderr = err instanceof Error ? err.message : String(err)
      errors.push(classifyGlabError(stderr).message)
    } finally {
      release()
    }
  }

  // Field edits via `glab issue update`.
  const editArgs: string[] = [
    'issue',
    'update',
    String(issueNumber),
    '-R',
    repoFlag,
    ...glabHostnameArgs(projectRef, connectionId)
  ]
  let hasEditArgs = false

  if (updates.title) {
    editArgs.push('--title', updates.title)
    hasEditArgs = true
  }
  for (const label of updates.addLabels ?? []) {
    editArgs.push('--label', label)
    hasEditArgs = true
  }
  for (const label of updates.removeLabels ?? []) {
    editArgs.push('--unlabel', label)
    hasEditArgs = true
  }
  for (const assignee of updates.addAssignees ?? []) {
    editArgs.push('--assignee', assignee)
    hasEditArgs = true
  }
  for (const assignee of updates.removeAssignees ?? []) {
    editArgs.push('--unassignee', assignee)
    hasEditArgs = true
  }

  if (hasEditArgs) {
    await acquire()
    try {
      await glabExecFileAsync(
        editArgs,
        glabRepoExecOptions(repoPath, connectionId, localGitOptions)
      )
    } catch (err) {
      const stderr = err instanceof Error ? err.message : String(err)
      errors.push(classifyGlabError(stderr).message)
    } finally {
      release()
    }
  }

  if (errors.length > 0) {
    return { ok: false, error: errors.join('; ') }
  }
  return { ok: true }
}
