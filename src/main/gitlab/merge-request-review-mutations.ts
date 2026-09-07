import type {
  GitLabAssignableUser,
  GitLabDiscussionResolveResult,
  GitLabMRInlineCommentInput,
  GitLabMRReviewersUpdateResult,
  MRComment
} from '../../shared/gitlab-types'
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

export async function addMRComment(
  repoPath: string,
  iid: number,
  body: string,
  preference?: IssueSourcePreference,
  connectionId?: string | null,
  projectRef?: ProjectRef | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<{ ok: true; comment: MRComment } | { ok: false; error: string }> {
  return withProjectRef<{ ok: true; comment: MRComment } | { ok: false; error: string }>(
    repoPath,
    preference,
    connectionId,
    projectRef,
    async (projectRef) => {
      await acquire()
      try {
        const { stdout } = await glabExecFileAsync(
          [
            'api',
            ...glabHostnameArgs(projectRef, connectionId),
            '-X',
            'POST',
            `projects/${encodedProject(projectRef.path)}/merge_requests/${iid}/notes`,
            '-f',
            `body=${body}`
          ],
          glabRepoExecOptions(repoPath, connectionId, localGitOptions)
        )
        const data = JSON.parse(stdout) as {
          id?: number
          author?: { username?: string; avatar_url?: string; state?: string } | null
          body?: string
          created_at?: string
        }
        return {
          ok: true,
          comment: {
            id: data.id ?? Date.now(),
            author: data.author?.username ?? 'You',
            authorAvatarUrl: data.author?.avatar_url ?? '',
            body: data.body ?? body,
            createdAt: data.created_at ?? new Date().toISOString(),
            url: '',
            isBot: data.author?.state === 'bot'
          }
        }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      } finally {
        release()
      }
    },
    { ok: false, error: 'Could not resolve GitLab project for this repository' },
    localGitOptions
  )
}

export async function addMRInlineComment(
  repoPath: string,
  iid: number,
  input: GitLabMRInlineCommentInput,
  preference?: IssueSourcePreference,
  connectionId?: string | null,
  projectRef?: ProjectRef | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<{ ok: true; comment: MRComment } | { ok: false; error: string }> {
  return withProjectRef<{ ok: true; comment: MRComment } | { ok: false; error: string }>(
    repoPath,
    preference,
    connectionId,
    projectRef,
    async (projectRef) => {
      const body = input.body.trim()
      if (!body) {
        return { ok: false, error: 'Comment body is required' }
      }
      await acquire()
      try {
        const oldPath = input.oldPath ?? input.path
        const { stdout } = await glabExecFileAsync(
          [
            'api',
            ...glabHostnameArgs(projectRef, connectionId),
            '-X',
            'POST',
            `projects/${encodedProject(projectRef.path)}/merge_requests/${iid}/discussions`,
            '-f',
            `body=${body}`,
            '-f',
            'position[position_type]=text',
            '-f',
            `position[base_sha]=${input.baseSha}`,
            '-f',
            `position[start_sha]=${input.startSha}`,
            '-f',
            `position[head_sha]=${input.headSha}`,
            '-f',
            `position[old_path]=${oldPath}`,
            '-f',
            `position[new_path]=${input.path}`,
            '-f',
            `position[new_line]=${input.line}`
          ],
          glabRepoExecOptions(repoPath, connectionId, localGitOptions)
        )
        const data = JSON.parse(stdout) as {
          id?: string
          notes?: {
            id?: number
            author?: { username?: string; avatar_url?: string; state?: string } | null
            body?: string
            created_at?: string
            position?: { new_path?: string; new_line?: number } | null
          }[]
        }
        const note = data.notes?.[0]
        return {
          ok: true,
          comment: {
            id: note?.id ?? Date.now(),
            author: note?.author?.username ?? 'You',
            authorAvatarUrl: note?.author?.avatar_url ?? '',
            body: note?.body ?? body,
            createdAt: note?.created_at ?? new Date().toISOString(),
            url: '',
            threadId: data.id,
            isResolved: false,
            isBot: note?.author?.state === 'bot',
            path: note?.position?.new_path ?? input.path,
            line: note?.position?.new_line ?? input.line
          }
        }
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

export async function resolveMRDiscussion(
  repoPath: string,
  iid: number,
  discussionId: string,
  resolved: boolean,
  preference?: IssueSourcePreference,
  connectionId?: string | null,
  projectRef?: ProjectRef | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GitLabDiscussionResolveResult> {
  return withProjectRef<GitLabDiscussionResolveResult>(
    repoPath,
    preference,
    connectionId,
    projectRef,
    async (projectRef) => {
      const trimmedDiscussionId = discussionId.trim()
      if (!trimmedDiscussionId) {
        return { ok: false, error: 'Discussion id is required' }
      }
      await acquire()
      try {
        // Why: GitLab resolves/reopens the whole discussion thread, not a single note.
        await glabExecFileAsync(
          [
            'api',
            ...glabHostnameArgs(projectRef, connectionId),
            '-X',
            'PUT',
            `projects/${encodedProject(projectRef.path)}/merge_requests/${iid}/discussions/${encodeURIComponent(trimmedDiscussionId)}`,
            '-f',
            `resolved=${resolved ? 'true' : 'false'}`
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

function mapGitLabReviewer(raw: {
  id?: number
  username?: string | null
  name?: string | null
  avatar_url?: string | null
  state?: string | null
}): GitLabAssignableUser | null {
  if (!raw.username) {
    return null
  }
  return {
    ...(typeof raw.id === 'number' ? { id: raw.id } : {}),
    username: raw.username,
    name: raw.name ?? null,
    avatarUrl: raw.avatar_url ?? '',
    ...(raw.state !== undefined ? { state: raw.state } : {})
  }
}

export async function updateMRReviewers(
  repoPath: string,
  iid: number,
  reviewerIds: number[],
  preference?: IssueSourcePreference,
  connectionId?: string | null,
  projectRef?: ProjectRef | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GitLabMRReviewersUpdateResult> {
  return withProjectRef<GitLabMRReviewersUpdateResult>(
    repoPath,
    preference,
    connectionId,
    projectRef,
    async (projectRef) => {
      await acquire()
      try {
        const fields =
          reviewerIds.length > 0
            ? reviewerIds.flatMap((id) => ['-f', `reviewer_ids[]=${id}`])
            : ['-f', 'reviewer_ids=']
        const { stdout } = await glabExecFileAsync(
          [
            'api',
            ...glabHostnameArgs(projectRef, connectionId),
            '-X',
            'PUT',
            `projects/${encodedProject(projectRef.path)}/merge_requests/${iid}`,
            ...fields
          ],
          glabRepoExecOptions(repoPath, connectionId, localGitOptions)
        )
        const data = JSON.parse(stdout) as { reviewers?: Parameters<typeof mapGitLabReviewer>[0][] }
        return {
          ok: true,
          reviewers: (data.reviewers ?? [])
            .map(mapGitLabReviewer)
            .filter((u): u is GitLabAssignableUser => !!u)
        }
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
