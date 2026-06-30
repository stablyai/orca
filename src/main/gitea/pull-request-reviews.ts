import type { GiteaMutationResult, GiteaPRReviewComment } from '../../shared/gitea-types'
import { getGiteaRepoRef } from './repository-ref'
import { encodedRepoPath, giteaRepoGet, giteaRepoWrite } from './request'
import { mapGiteaUser, type RawGiteaUser } from './mappers'

// Diff-anchored (inline) PR review comments. Kept out of pull-requests.ts so
// that file stays focused on PR detail/files/checks/merge.

type RawGiteaReview = { id?: number; comments_count?: number }

type RawGiteaReviewComment = {
  id?: number
  body?: string | null
  path?: string | null
  position?: number | null
  created_at?: string | null
  user?: RawGiteaUser | null
}

// Lists inline (diff-anchored) review comments across all reviews of a PR.
export async function listGiteaPullRequestReviewComments(
  repoPath: string,
  prNumber: number,
  connectionId?: string | null
): Promise<GiteaPRReviewComment[]> {
  const repo = await getGiteaRepoRef(repoPath, connectionId)
  if (!repo) {
    return []
  }
  const base = `/repos/${encodedRepoPath(repo)}/pulls/${encodeURIComponent(String(prNumber))}/reviews`
  const reviews = await giteaRepoGet<RawGiteaReview[]>(repo, base)
  if (!Array.isArray(reviews)) {
    return []
  }
  const withComments = reviews.filter(
    (review) => typeof review.id === 'number' && (review.comments_count ?? 0) > 0
  )
  const groups = await Promise.all(
    withComments.map((review) =>
      giteaRepoGet<RawGiteaReviewComment[]>(repo, `${base}/${review.id}/comments`)
    )
  )
  return groups
    .flat()
    .filter((comment): comment is RawGiteaReviewComment => Boolean(comment))
    .filter((comment) => typeof comment.id === 'number' && typeof comment.position === 'number')
    .map((comment) => ({
      id: comment.id as number,
      body: comment.body ?? '',
      path: comment.path ?? '',
      line: comment.position as number,
      createdAt: comment.created_at ?? '',
      user: mapGiteaUser(comment.user)
    }))
}

// Adds a diff-anchored review comment on a file line (new-file line number).
export async function addGiteaPullRequestReviewComment(
  repoPath: string,
  prNumber: number,
  args: { path: string; line: number; body: string },
  connectionId?: string | null
): Promise<GiteaMutationResult> {
  const repo = await getGiteaRepoRef(repoPath, connectionId)
  if (!repo) {
    return { ok: false, error: 'This repository is not a recognized Gitea remote.' }
  }
  const result = await giteaRepoWrite<unknown>(
    repo,
    `/repos/${encodedRepoPath(repo)}/pulls/${encodeURIComponent(String(prNumber))}/reviews`,
    {
      method: 'POST',
      body: {
        event: 'COMMENT',
        body: '',
        comments: [{ path: args.path, body: args.body, new_position: args.line }]
      }
    }
  )
  return result.ok ? { ok: true } : { ok: false, error: result.error }
}
