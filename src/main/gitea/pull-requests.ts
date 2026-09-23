import type {
  GiteaMergeMethod,
  GiteaMutationResult,
  GiteaPRCheck,
  GiteaPRFile,
  GiteaPRFileContents,
  GiteaPRFileStatus,
  GiteaPRReviewComment,
  GiteaPullRequestDetail
} from '../../shared/gitea-types'
import { getGiteaRepoRef } from './repository-ref'
import { encodedRepoPath, giteaRepoGet, giteaRepoGetText, giteaRepoWrite } from './request'
import { mapGiteaPullRequestState, type RawGiteaPullRequest } from './pull-request-mappers'
import { mapGiteaUser, type RawGiteaUser } from './mappers'

type RawGiteaPullDetail = RawGiteaPullRequest & {
  body?: string | null
  user?: RawGiteaUser | null
  base?: { ref?: string | null; sha?: string | null } | null
  merged?: boolean | null
  mergeable?: boolean | null
  additions?: number
  deletions?: number
  changed_files?: number
  comments?: number
  created_at?: string | null
}

type RawGiteaPullFile = {
  filename?: string | null
  previous_filename?: string | null
  status?: string | null
  additions?: number
  deletions?: number
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

function mapFileStatus(status: string | null | undefined): GiteaPRFileStatus {
  switch (status) {
    case 'added':
    case 'modified':
    case 'deleted':
    case 'renamed':
    case 'copied':
      return status
    case null:
    case undefined:
    default:
      return 'changed'
  }
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
  repoPath: string,
  prNumber: number,
  connectionId?: string | null
): Promise<GiteaPullRequestDetail | null> {
  const repo = await getGiteaRepoRef(repoPath, connectionId)
  if (!repo) {
    return null
  }
  const raw = await giteaRepoGet<RawGiteaPullDetail>(
    repo,
    `/repos/${encodedRepoPath(repo)}/pulls/${encodeURIComponent(String(prNumber))}`
  )
  if (!raw || typeof raw.number !== 'number' || !raw.html_url) {
    return null
  }
  return {
    number: raw.number,
    title: raw.title ?? '',
    body: raw.body?.trim() || undefined,
    state: mapGiteaPullRequestState(raw),
    url: raw.html_url,
    author: mapGiteaUser(raw.user),
    headBranch: raw.head?.ref ?? '',
    baseBranch: raw.base?.ref ?? '',
    headSha: raw.head?.sha ?? '',
    baseSha: raw.base?.sha ?? '',
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

export async function listGiteaPullRequestFiles(
  repoPath: string,
  prNumber: number,
  connectionId?: string | null
): Promise<GiteaPRFile[]> {
  const repo = await getGiteaRepoRef(repoPath, connectionId)
  if (!repo) {
    return []
  }
  const raw = await giteaRepoGet<RawGiteaPullFile[]>(
    repo,
    `/repos/${encodedRepoPath(repo)}/pulls/${encodeURIComponent(String(prNumber))}/files`,
    { searchParams: { limit: 100, page: 1 } }
  )
  if (!Array.isArray(raw)) {
    return []
  }
  return raw
    .filter((entry): entry is RawGiteaPullFile & { filename: string } => Boolean(entry.filename))
    .map((entry) => ({
      path: entry.filename,
      oldPath: entry.previous_filename?.trim() || undefined,
      status: mapFileStatus(entry.status),
      additions: typeof entry.additions === 'number' ? entry.additions : 0,
      deletions: typeof entry.deletions === 'number' ? entry.deletions : 0
    }))
}

// Fetches the file's content at the base and head commits so the renderer can
// show a Monaco diff. Added files have no base content; deleted files have no
// head content.
export async function getGiteaPullRequestFileContents(
  repoPath: string,
  args: {
    path: string
    oldPath?: string
    status: GiteaPRFileStatus
    baseSha: string
    headSha: string
  },
  connectionId?: string | null
): Promise<GiteaPRFileContents> {
  const empty: GiteaPRFileContents = {
    original: '',
    modified: '',
    originalIsBinary: false,
    modifiedIsBinary: false
  }
  const repo = await getGiteaRepoRef(repoPath, connectionId)
  if (!repo) {
    return empty
  }
  const basePath = args.oldPath ?? args.path
  const wantOriginal = args.status !== 'added'
  const wantModified = args.status !== 'deleted'
  const [original, modified] = await Promise.all([
    wantOriginal
      ? giteaRepoGetText(repo, `/repos/${encodedRepoPath(repo)}/raw/${encodePath(basePath)}`, {
          searchParams: { ref: args.baseSha }
        })
      : Promise.resolve(''),
    wantModified
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
  repoPath: string,
  headSha: string,
  connectionId?: string | null
): Promise<GiteaPRCheck[]> {
  const repo = await getGiteaRepoRef(repoPath, connectionId)
  if (!repo || !headSha) {
    return []
  }
  const raw = await giteaRepoGet<RawGiteaCombinedStatusDetail>(
    repo,
    `/repos/${encodedRepoPath(repo)}/commits/${encodeURIComponent(headSha)}/status`
  )
  const statuses = raw?.statuses ?? []
  return statuses.map((entry) => ({
    context: entry.context?.trim() || 'status',
    state: mapCheckState(entry.status ?? entry.state),
    targetUrl: entry.target_url?.trim() || undefined,
    description: entry.description?.trim() || undefined
  }))
}

export async function mergeGiteaPullRequest(
  repoPath: string,
  prNumber: number,
  method: GiteaMergeMethod,
  connectionId?: string | null
): Promise<GiteaMutationResult> {
  const repo = await getGiteaRepoRef(repoPath, connectionId)
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
