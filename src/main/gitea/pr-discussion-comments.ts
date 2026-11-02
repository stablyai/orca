import type { MRComment } from '../../shared/gitlab-types'
import { requestGiteaJson } from './client'
import type { GiteaRepoRef, LocalGitExecOptions } from './repository-ref'

// One page keeps a huge PR from retaining every historic comment.
const DETAIL_PAGE_LIMIT = 100

export type RawGiteaReviewUser = {
  id?: number
  login: string
  avatar_url: string
}

export type RawGiteaReview = {
  id: number
  body: string
  html_url: string
  submitted_at: string
  state: string
  dismissed: boolean
  user: RawGiteaReviewUser | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  return typeof value === 'string' ? value : ''
}

function readNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : []
}

function repoResource(repo: GiteaRepoRef, suffix: string): string {
  return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}${suffix}`
}

function pageOptions(): { searchParams: { limit: number } } {
  return { searchParams: { limit: DETAIL_PAGE_LIMIT } }
}

function account(
  record: Record<string, unknown>
): { id?: number; login: string; avatarUrl: string } | null {
  const login = readString(record, 'login') || readString(record, 'username')
  if (!login) {
    return null
  }
  const id = readNumber(record, 'id')
  return {
    login,
    avatarUrl: readString(record, 'avatar_url'),
    ...(id !== null ? { id } : {})
  }
}

function commentAuthor(record: Record<string, unknown>): { login: string; avatarUrl: string } {
  const user = isRecord(record.user) ? account(record.user) : null
  if (user) {
    return user
  }
  const reviewer = isRecord(record.reviewer) ? account(record.reviewer) : null
  return reviewer ?? { login: 'unknown', avatarUrl: '' }
}

function isBotLogin(login: string): boolean {
  return login.toLowerCase().endsWith('[bot]')
}

function mapTimelineComment(record: Record<string, unknown>): MRComment | null {
  const id = readNumber(record, 'id')
  if (id === null) {
    return null
  }
  const author = commentAuthor(record)
  return {
    id,
    author: author.login,
    authorAvatarUrl: author.avatarUrl,
    body: readString(record, 'body'),
    createdAt: readString(record, 'created_at'),
    url: readString(record, 'html_url'),
    isBot: isBotLogin(author.login)
  }
}

function commentLine(record: Record<string, unknown>): number | null {
  const position = readNumber(record, 'position')
  if (position !== null && position > 0) {
    return position
  }
  const oldPosition = readNumber(record, 'old_position')
  if (oldPosition !== null && oldPosition > 0) {
    return oldPosition
  }
  return null
}

function mapInlineComment(record: Record<string, unknown>): MRComment | null {
  const comment = mapTimelineComment(record)
  if (!comment) {
    return null
  }
  const line = commentLine(record)
  const path = readString(record, 'path')
  return {
    ...comment,
    threadId: String(comment.id),
    isResolved: Boolean(record.resolver),
    ...(path ? { path } : {}),
    ...(line !== null ? { line } : {})
  }
}

function mapReview(record: Record<string, unknown>): RawGiteaReview | null {
  const id = readNumber(record, 'id')
  if (id === null) {
    return null
  }
  const user = isRecord(record.user) ? account(record.user) : null
  return {
    id,
    body: readString(record, 'body'),
    html_url: readString(record, 'html_url'),
    submitted_at: readString(record, 'submitted_at'),
    state: readString(record, 'state'),
    dismissed: record.dismissed === true,
    user: user
      ? {
          login: user.login,
          avatar_url: user.avatarUrl,
          ...(user.id !== undefined ? { id: user.id } : {})
        }
      : null
  }
}

function mapReviewSummary(review: RawGiteaReview): MRComment | null {
  if (!review.body.trim()) {
    return null
  }
  const author = review.user?.login ?? 'unknown'
  return {
    id: review.id,
    author,
    authorAvatarUrl: review.user?.avatar_url ?? '',
    body: review.body,
    createdAt: review.submitted_at,
    url: review.html_url,
    isBot: isBotLogin(author),
    threadId: String(review.id)
  }
}

function byCreatedAt(left: MRComment, right: MRComment): number {
  const created = left.createdAt.localeCompare(right.createdAt)
  if (created !== 0) {
    return created
  }
  return left.id - right.id
}

function presentComments(
  value: unknown,
  map: (record: Record<string, unknown>) => MRComment | null
): MRComment[] {
  return records(value).flatMap((record) => {
    const comment = map(record)
    return comment ? [comment] : []
  })
}

export async function fetchGiteaIssueComments(
  repo: GiteaRepoRef,
  index: number,
  connectionId?: string | null,
  localGitOptions?: LocalGitExecOptions
): Promise<MRComment[]> {
  void connectionId
  void localGitOptions
  const data = await requestGiteaJson<unknown>(
    repo,
    repoResource(repo, `/issues/${encodeURIComponent(String(index))}/comments`),
    pageOptions()
  )
  return presentComments(data, mapTimelineComment).sort(byCreatedAt)
}

export async function fetchGiteaPRCommentsAndReviews(
  repo: GiteaRepoRef,
  index: number,
  connectionId?: string | null,
  localGitOptions?: LocalGitExecOptions
): Promise<{ comments: MRComment[]; reviews: RawGiteaReview[] }> {
  const indexPath = encodeURIComponent(String(index))
  const [issueComments, reviewData] = await Promise.all([
    fetchGiteaIssueComments(repo, index, connectionId, localGitOptions),
    requestGiteaJson<unknown>(
      repo,
      repoResource(repo, `/pulls/${indexPath}/reviews`),
      pageOptions()
    )
  ])
  const reviews = records(reviewData).flatMap((record) => {
    const review = mapReview(record)
    return review ? [review] : []
  })
  const inlineGroups = await Promise.all(
    reviews.map((review) =>
      requestGiteaJson<unknown>(
        repo,
        repoResource(
          repo,
          `/pulls/${indexPath}/reviews/${encodeURIComponent(String(review.id))}/comments`
        ),
        pageOptions()
      )
    )
  )
  const inline = inlineGroups.flatMap((group) => presentComments(group, mapInlineComment))
  const summaries = reviews.flatMap((review) => {
    const comment = mapReviewSummary(review)
    return comment ? [comment] : []
  })
  return {
    comments: [...issueComments, ...summaries, ...inline].sort(byCreatedAt),
    reviews
  }
}
