import type { GitHubCommentResult, PRComment } from '../../shared/github/comment-types'
import type { IssueSourcePreference } from '../../shared/repo-types'
import type { LocalGitExecOptions, OwnerRepo } from './gh-utils'
import {
  resolveGitHubRepoExecution,
  resolveIssueGitHubApiRepositorySource
} from './github-api-repository'
import { acquire, classifyGhError, ghExecFileAsync, release } from './gh-utils'

/**
 * Add a comment to an existing GitHub issue.
 *
 * Why `preference`: issue details are read from the preference-selected repo
 * (see `getWorkItemDetails`), so replies must post to that same repo — the
 * upstream-first heuristic would post a reply read on origin#N to upstream#N.
 */
export async function addIssueComment(
  repoPath: string,
  issueNumber: number,
  body: string,
  connectionId?: string | null,
  ownerRepoOverride?: OwnerRepo | null,
  localGitOptions: LocalGitExecOptions = {},
  preference?: IssueSourcePreference
): Promise<GitHubCommentResult> {
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
    return { ok: false, error: 'Could not resolve GitHub owner/repo for this repository' }
  }
  await acquire()
  try {
    const { stdout } = await ghExecFileAsync(
      [
        'api',
        '-X',
        'POST',
        `repos/${ownerRepo.owner}/${ownerRepo.repo}/issues/${issueNumber}/comments`,
        '--raw-field',
        `body=${body}`
      ],
      ghOptions
    )
    const data = JSON.parse(stdout) as {
      id?: number
      node_id?: string | null
      user: { login: string; avatar_url: string; type?: string } | null
      body?: string
      created_at?: string
      html_url?: string
    }
    if (typeof data.id !== 'number' || !Number.isSafeInteger(data.id) || data.id < 1) {
      return { ok: false, error: 'Unexpected response from GitHub' }
    }
    const comment: PRComment = {
      id: data.id,
      reactionSubjectId: data.node_id?.trim() || undefined,
      author: data.user?.login ?? 'You',
      authorAvatarUrl: data.user?.avatar_url ?? '',
      body: data.body ?? body,
      createdAt: data.created_at ?? new Date().toISOString(),
      url: data.html_url ?? '',
      isBot: data.user?.type === 'Bot'
    }
    return { ok: true, comment }
  } catch (err) {
    const stderr = err instanceof Error ? err.message : String(err)
    return { ok: false, error: classifyGhError(stderr).message }
  } finally {
    release()
  }
}
