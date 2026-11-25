import { resolveGiteaRepoTarget, type GiteaRepoTarget } from './requests/gitea-repo-target'
import type {
  GiteaMergeMethod,
  GiteaMutationResult,
  GiteaPRCheck,
  GiteaPRFileContents,
  GiteaPRFileStatus,
  GiteaPRReviewComment,
  GiteaPullRequestDetail
} from '../../shared/gitea/gitea-types'
import {
  encodedRepoPath,
  giteaRepoGet,
  giteaRepoGetText,
  giteaRepoWrite
} from './requests/gitea-request'
import { mapGiteaPullRequestState, type RawGiteaPullRequest } from './pull-request-mappers'
import { mapGiteaUser, type RawGiteaUser } from './issues/gitea-work-item-mappers'

type RawGiteaPullDetail = RawGiteaPullRequest & {
  body?: string | null
  user?: RawGiteaUser | null
  base?: { ref?: string | null; sha?: string | null } | null
  merge_base?: string | null
  merged?: boolean | null
  mergeable?: boolean | null
  additions?: number
  deletions?: number
  changed_files?: number
  comments?: number
  created_at?: string | null
}

type RawGiteaStatusEntry = {
  status?: string | null
  state?: string | null
  context?: string | null
  target_url?: string | null
  description?: string | null
}

type RawGiteaCombinedStatusDetail = {
  statuses?: RawGiteaStatusEntry[] | null
}

function mapCheckState(value: string | null | undefined): GiteaPRCheck['state'] {
  switch (value?.trim().toLowerCase()) {
    case 'success':
      return 'success'
    case 'failure':
      return 'failure'
    case 'error':
      return 'error'
    case 'warning':
      return 'warning'
    case undefined:
    default:
      return 'pending'
  }
}

// Encodes a repo file path for the raw-content endpoint, preserving slashes.
function encodePath(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

function looksBinary(content: string): boolean {
  // A NUL byte is a reliable signal that the raw content is not text.
  return content.includes(String.fromCharCode(0))
}

export async function getGiteaPullRequestDetail(
  target: GiteaRepoTarget,
  prNumber: number
): Promise<GiteaPullRequestDetail | null> {
  const repo = await resolveGiteaRepoTarget(target)
  if (!repo) {
    return null
  }
  const raw = await giteaRepoGet<RawGiteaPullDetail>(
    repo,
    `/repos/${encodedRepoPath(repo)}/pulls/${encodeURIComponent(String(prNumber))}`,
    {},
    true
  )
  if (!raw || typeof raw.number !== 'number' || !raw.html_url) {
    return null
  }
  return {
    number: raw.number,
    title: raw.title ?? '',
    body: raw.body?.trim() ? raw.body : undefined,
    state: mapGiteaPullRequestState(raw),
    url: raw.html_url,
    author: mapGiteaUser(raw.user),
    headBranch: raw.head?.ref ?? '',
    baseBranch: raw.base?.ref ?? '',
    headSha: raw.head?.sha ?? '',
    // File diffs start at the merge base, not the target tip, so target-only edits stay out of them.
    baseSha: raw.merge_base?.trim() || raw.base?.sha || '',
    mergeable: raw.mergeable === true,
    merged: raw.merged === true,
    additions: typeof raw.additions === 'number' ? raw.additions : undefined,
    deletions: typeof raw.deletions === 'number' ? raw.deletions : undefined,
    changedFiles: typeof raw.changed_files === 'number' ? raw.changed_files : undefined,
    comments: typeof raw.comments === 'number' ? raw.comments : 0,
    updatedAt: raw.updated_at ?? '',
    createdAt: raw.created_at ?? ''
  }
}

// Fetches the file's content at the base and head commits so the renderer can
// show a Monaco diff. Added files have no base content; deleted files have no
// head content.
export async function getGiteaPullRequestFileContents(
  target: GiteaRepoTarget,
  args: {
    path: string
    oldPath?: string
    status: GiteaPRFileStatus
    baseSha: string
    headSha: string
  }
): Promise<GiteaPRFileContents> {
  const empty: GiteaPRFileContents = {
    original: '',
    modified: '',
    originalIsBinary: false,
    modifiedIsBinary: false
  }
  const repo = await resolveGiteaRepoTarget(target)
  if (!repo) {
    return empty
  }
  const basePath = args.oldPath ?? args.path
  const [original, modified] = await Promise.all([
    args.status !== 'added'
      ? giteaRepoGetText(repo, `/repos/${encodedRepoPath(repo)}/raw/${encodePath(basePath)}`, {
          searchParams: { ref: args.baseSha }
        })
      : Promise.resolve(''),
    args.status !== 'deleted'
      ? giteaRepoGetText(repo, `/repos/${encodedRepoPath(repo)}/raw/${encodePath(args.path)}`, {
          searchParams: { ref: args.headSha }
        })
      : Promise.resolve('')
  ])
  return {
    original: original ?? '',
    modified: modified ?? '',
    originalIsBinary: looksBinary(original ?? ''),
    modifiedIsBinary: looksBinary(modified ?? '')
  }
}

export async function getGiteaPullRequestChecks(
  target: GiteaRepoTarget,
  headSha: string
): Promise<GiteaPRCheck[]> {
  const repo = await resolveGiteaRepoTarget(target)
  if (!repo || !headSha) {
    return []
  }
  const raw = await giteaRepoGet<RawGiteaCombinedStatusDetail>(
    repo,
    `/repos/${encodedRepoPath(repo)}/commits/${encodeURIComponent(headSha)}/status`,
    {},
    true
  )
  return (raw?.statuses ?? []).map((entry) => ({
    context: entry.context?.trim() || 'status',
    state: mapCheckState(entry.status ?? entry.state),
    targetUrl: entry.target_url?.trim() || undefined,
    description: entry.description?.trim() || undefined
  }))
}

export async function mergeGiteaPullRequest(
  target: GiteaRepoTarget,
  prNumber: number,
  method: GiteaMergeMethod
): Promise<GiteaMutationResult> {
  const repo = await resolveGiteaRepoTarget(target)
  if (!repo) {
    return { ok: false, error: 'This repository is not a recognized Gitea remote.' }
  }
  const result = await giteaRepoWrite<unknown>(
    repo,
    `/repos/${encodedRepoPath(repo)}/pulls/${encodeURIComponent(String(prNumber))}/merge`,
    { method: 'POST', body: { Do: method } }
  )
  return result.ok ? { ok: true } : { ok: false, error: result.error }
}

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
  target: GiteaRepoTarget,
  prNumber: number
): Promise<GiteaPRReviewComment[]> {
  const repo = await resolveGiteaRepoTarget(target)
  if (!repo) {
    return []
  }
  const base = `/repos/${encodedRepoPath(repo)}/pulls/${encodeURIComponent(String(prNumber))}/reviews`
  const reviews = await giteaRepoGet<RawGiteaReview[]>(repo, base, {}, true)
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
  return groups.flat().flatMap((comment) => {
    if (!comment || typeof comment.id !== 'number' || typeof comment.position !== 'number') {
      return []
    }
    return [
      {
        id: comment.id,
        body: comment.body ?? '',
        path: comment.path ?? '',
        line: comment.position,
        createdAt: comment.created_at ?? '',
        user: mapGiteaUser(comment.user)
      }
    ]
  })
}

// Adds a diff-anchored review comment on a file line (new-file line number).
export async function addGiteaPullRequestReviewComment(
  target: GiteaRepoTarget,
  prNumber: number,
  args: { path: string; line: number; body: string }
): Promise<GiteaMutationResult> {
  const repo = await resolveGiteaRepoTarget(target)
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
