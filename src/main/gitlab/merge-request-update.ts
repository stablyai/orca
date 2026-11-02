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
import { tryMarkMRReady } from './merge-request-ready'
import { codeHostFailure, classifiedFailure } from '../../shared/code-host-failure-copy'
import { invalidateReviewLookupsAfterPRMutation } from '../github/pr-mutation-review-invalidation'

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
      let readinessApplied = false
      try {
        if (updates.readyForReview && updates.title !== undefined) {
          return codeHostFailure('gitlab.readyTitleConflict')
        }

        const endpoint = `projects/${encodedProject(projectRef.path)}/merge_requests/${iid}`
        let title = updates.title?.trim()
        const query = `mutation { mergeRequestSetDraft(input: { projectPath: ${JSON.stringify(projectRef.path)}, iid: ${JSON.stringify(String(iid))}, draft: false }) { mergeRequest { iid } errors } }`
        if (updates.readyForReview) {
          readinessApplied = await tryMarkMRReady(
            [
              'api',
              ...glabHostnameArgs(projectRef, connectionId),
              'graphql',
              '-i',
              '-f',
              `query=${query}`
            ],
            glabRepoExecOptions(repoPath, connectionId, localGitOptions),
            iid
          )
        }
        if (updates.readyForReview && !readinessApplied) {
          const response = await glabExecFileAsync(
            ['api', ...glabHostnameArgs(projectRef, connectionId), endpoint],
            glabRepoExecOptions(repoPath, connectionId, localGitOptions)
          )
          const currentTitle = (JSON.parse(response.stdout) as { title?: unknown }).title
          if (typeof currentTitle !== 'string') {
            return codeHostFailure('gitlab.mergeRequestTitleUnreadable')
          }
          title = stripGitLabDraftTitlePrefix(currentTitle) ?? undefined
        }

        const fields: string[] = []
        if (title !== undefined) {
          if (!title.trim()) {
            return codeHostFailure('titleRequired')
          }
          fields.push(`title=${title.trim()}`)
        } else if (updates.title !== undefined) {
          return codeHostFailure('titleRequired')
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
        if (readinessApplied) {
          const metadata = [
            updates.body !== undefined ? 'description' : null,
            [...(updates.addLabels ?? []), ...(updates.removeLabels ?? [])].some((label) =>
              label.trim()
            )
              ? 'labels'
              : null
          ]
            .filter((field) => field !== null)
            .join(' and ')
          return {
            ok: false,
            error: `GitLab marked the merge request ready, but could not confirm the ${metadata} update. Retry only those edits.`
          }
        }
        const msg = err instanceof Error ? err.message : String(err)
        return classifiedFailure(classifyGlabError(msg))
      } finally {
        release()
        // Even a failed write may have landed; later reads must not reuse an answer from before it.
        invalidateReviewLookupsAfterPRMutation(repoPath, connectionId)
      }
    },
    codeHostFailure('gitlab.projectUnresolved'),
    localGitOptions
  )
}
