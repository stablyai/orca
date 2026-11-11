import type { GitLabIssueUpdate } from '../../../shared/gitlab-types'
import type { IssueSourcePreference } from '../../../shared/repo-types'
import { acquire, release } from '../requests/glab-request-admission'
import { classifyGlabError } from '../requests/glab-error-classification'
import { getGlabKnownHosts, type LocalGitExecOptions } from '../projects/gitlab-known-host-probe'
import { glabExecFileAsync } from '../../git/command-runner/glab-exec-file'
import {
  glabHostEnvOptions,
  glabHostnameArgs,
  glabRepoExecOptions
} from '../projects/gitlab-project-ref-resolution'
import { resolveIssueSource } from './gitlab-issue-source-resolution'
import type { ProjectRef } from '../projects/project-ref-parser'
import { encodedProject } from '../projects/project-path-encoding'
import { codeHostFailure, combinedClassifiedFailure } from '../../../shared/code-host-failure-copy'
import type { ClassifiedError } from '../../../shared/classified-error'

/** Mutate the preference-selected project so equal origin/upstream issue numbers cannot retarget edits. */
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
    return codeHostFailure('gitlab.projectUnresolved')
  }

  const repoFlag = projectRef.path
  const errors: ClassifiedError[] = []

  if (updates.state) {
    await acquire()
    try {
      const cmd = updates.state === 'closed' ? 'close' : 'reopen'
      await glabExecFileAsync(['issue', cmd, String(issueNumber), '-R', repoFlag], {
        ...glabRepoExecOptions(repoPath, connectionId, localGitOptions),
        ...glabHostEnvOptions(projectRef, connectionId)
      })
    } catch (err) {
      // glab already-state transitions exit 0; any rejected command remains a real failure.
      const stderr = err instanceof Error ? err.message : String(err)
      errors.push(classifyGlabError(stderr))
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
      errors.push(classifyGlabError(stderr))
    } finally {
      release()
    }
  }

  const editArgs: string[] = ['issue', 'update', String(issueNumber), '-R', repoFlag]
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
  // Bare --assignee replaces everyone; + and - prefixes perform incremental edits (glab >=1.22).
  for (const assignee of updates.addAssignees ?? []) {
    editArgs.push(`--assignee=+${assignee}`)
    hasEditArgs = true
  }
  for (const assignee of updates.removeAssignees ?? []) {
    editArgs.push(`--assignee=-${assignee}`)
    hasEditArgs = true
  }

  if (hasEditArgs) {
    await acquire()
    try {
      await glabExecFileAsync(editArgs, {
        ...glabRepoExecOptions(repoPath, connectionId, localGitOptions),
        ...glabHostEnvOptions(projectRef, connectionId)
      })
    } catch (err) {
      const stderr = err instanceof Error ? err.message : String(err)
      errors.push(classifyGlabError(stderr))
    } finally {
      release()
    }
  }

  if (errors.length > 0) {
    return combinedClassifiedFailure(errors)
  }
  return { ok: true }
}
