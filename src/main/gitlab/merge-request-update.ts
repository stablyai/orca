import type { IssueSourcePreference } from '../../shared/repo-types'
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
import { withProjectRef } from './merge-request-project-resolution'

export async function updateMR(
  repoPath: string,
  iid: number,
  updates: {
    title?: string
    body?: string
    addLabels?: string[]
    removeLabels?: string[]
  },
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
      const fields: string[] = []
      const title = updates.title?.trim()
      if (updates.title !== undefined) {
        if (!title) {
          return { ok: false, error: 'Title is required' }
        }
        fields.push(`title=${title}`)
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

      await acquire()
      try {
        await glabExecFileAsync(
          [
            'api',
            ...glabHostnameArgs(projectRef, connectionId),
            '-X',
            'PUT',
            `projects/${encodedProject(projectRef.path)}/merge_requests/${iid}`,
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
