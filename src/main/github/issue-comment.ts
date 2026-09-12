import type { GitHubCommentResult, PRComment } from '../../shared/github/comment-types'
import type { LocalGitExecOptions, OwnerRepo } from './gh-utils'
import { getIssueGitHubApiRepository, resolveGitHubRepoExecution } from './github-api-repository'
import { acquire, classifyGhError, ghExecFileAsync, release } from './gh-utils'

/**
 * Add a comment to an existing GitHub issue.
 *
 * Why this path doesn't take a preference (mirrors `getIssue` / `updateIssue`):
 * a comment is posted against an issue number already bound to a worktree or
 * surfaced from a prior read. Routing through the live per-repo preference
 * would let a user read upstream#N, toggle the selector to origin, and have
 * their reply silently post on origin#N — a different issue entirely. That
 * is the same silent-source-switch class of wrongness #1186 / the parent
 * design doc guard against. List and create paths honor preference;
 * mutations stay on the heuristic `getIssueOwnerRepo`.
 */
export async function addIssueComment(
  repoPath: string,
  issueNumber: number,
  body: string,
  connectionId?: string | null,
  ownerRepoOverride?: OwnerRepo | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GitHubCommentResult> {
  const { ownerRepo, ghOptions } = await resolveGitHubRepoExecution(
    repoPath,
    ownerRepoOverride ??
      (() => getIssueGitHubApiRepository(repoPath, connectionId, localGitOptions)),
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
