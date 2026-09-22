import type { IssueSourcePreference } from '../../shared/repo-types'
import type { GitLabMRUpdate } from '../../shared/gitlab-types'
import {
  acquire,
  classifyGlabError,
  glabHostnameArgs,
  glabRepoExecOptions,
  glabExecFileAsync,
  release,
  type LocalGitExecOptions,
  type ProjectRef
} from './gl-utils'
import { encodedProject } from './project-path-encoding'
import { stripGitLabDraftTitlePrefix } from './merge-request-draft-title'
import { withProjectRef } from './merge-request-project-resolution'

export async function updateMR(
  repoPath: string,
  iid: number,
  updates: GitLabMRUpdate,
  preference?: IssueSourcePreference,
  connectionId?: string | null,
  projectRef?: ProjectRef | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<{ ok: true } | { ok: false; error: string }> {
  return withProjectRef<{ ok: true } | { ok: false; error: string }>(
    repoPath,
    preference,
    connectionId,
    projectRef,
    async (projectRef) => {
      if (
        !updates.readyForReview &&
        updates.title === undefined &&
        updates.body === undefined &&
        !(updates.addLabels ?? []).some((label) => label.trim()) &&
        !(updates.removeLabels ?? []).some((label) => label.trim())
      ) {
        return { ok: true }
      }
      await acquire()
      try {
        if (updates.readyForReview && updates.title !== undefined) {
          return { ok: false, error: 'Cannot update the title while marking a merge request ready' }
        }

        const endpoint = `projects/${encodedProject(projectRef.path)}/merge_requests/${iid}`
        let title = updates.title?.trim()
        if (updates.readyForReview) {
          const response = await glabExecFileAsync(
            ['api', ...glabHostnameArgs(projectRef, connectionId), endpoint],
            glabRepoExecOptions(repoPath, connectionId, localGitOptions)
          )
          const currentTitle = (JSON.parse(response.stdout) as { title?: unknown }).title
          if (typeof currentTitle !== 'string') {
            return { ok: false, error: 'Could not read the current merge request title' }
          }
          title = stripGitLabDraftTitlePrefix(currentTitle) ?? undefined
        }

        const fields: string[] = []
        if (title !== undefined) {
          if (!title.trim()) {
            return { ok: false, error: 'Title is required' }
          }
          fields.push(`title=${title.trim()}`)
        } else if (updates.title !== undefined) {
          return { ok: false, error: 'Title is required' }
        }
        if (updates.body !== undefined) {
          fields.push(`description=${updates.body}`)
        }
        const addLabels = (updates.addLabels ?? []).filter((label) => label.trim().length > 0)
        const removeLabels = (updates.removeLabels ?? []).filter((label) => label.trim().length > 0)
        if (addLabels.length > 0) {
          fields.push(`add_labels=${addLabels.join(',')}`)
        }
        if (removeLabels.length > 0) {
          fields.push(`remove_labels=${removeLabels.join(',')}`)
        }
        if (fields.length === 0) {
          return { ok: true }
        }

        await glabExecFileAsync(
          [
            'api',
            ...glabHostnameArgs(projectRef, connectionId),
            '-X',
            'PUT',
            endpoint,
            ...fields.flatMap((field) => ['-f', field])
          ],
          glabRepoExecOptions(repoPath, connectionId, localGitOptions)
        )
        return { ok: true }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { ok: false, error: classifyGlabError(msg).message }
      } finally {
        release()
      }
    },
    { ok: false, error: 'Could not resolve GitLab project for this repository' },
    localGitOptions
  )
}

/** Re-export so callers don't need to know the gl-utils module split. */
