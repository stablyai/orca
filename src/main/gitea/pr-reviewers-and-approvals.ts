import type { RawGiteaReview } from './pr-discussion-comments'

export type GiteaAssignableUser = {
  id?: number
  username: string
  name: string | null
  avatarUrl: string
}

export type GiteaApprovalState = {
  approvedBy: GiteaAssignableUser[]
  changesRequested: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  return typeof value === 'string' ? value.trim() : ''
}

function readNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function byUsername(left: GiteaAssignableUser, right: GiteaAssignableUser): number {
  return left.username.localeCompare(right.username)
}

function parseRequestedReviewer(value: unknown): GiteaAssignableUser | null {
  if (!isRecord(value)) {
    return null
  }
  const username = readString(value, 'login') || readString(value, 'username')
  if (!username) {
    return null
  }
  const id = readNumber(value, 'id')
  const name = readString(value, 'full_name') || readString(value, 'name')
  return {
    ...(id !== null ? { id } : {}),
    username,
    name: name || null,
    avatarUrl: readString(value, 'avatar_url')
  }
}

function userFromReview(review: RawGiteaReview): GiteaAssignableUser | null {
  const username = review.user?.login.trim() ?? ''
  if (!username) {
    return null
  }
  return {
    ...(review.user?.id !== undefined ? { id: review.user.id } : {}),
    username,
    name: null,
    avatarUrl: review.user?.avatar_url ?? ''
  }
}

function reviewState(review: RawGiteaReview): string {
  return review.state.trim().toUpperCase()
}

function isNewerReview(candidate: RawGiteaReview, current: RawGiteaReview): boolean {
  const compared = candidate.submitted_at.localeCompare(current.submitted_at)
  if (compared !== 0) {
    return compared > 0
  }
  return candidate.id > current.id
}

/** Latest submission per user wins, including a newer dismissal of an older approval. */
export function latestGiteaReviewsByUser(reviews: RawGiteaReview[]): RawGiteaReview[] {
  const byUser = new Map<string, RawGiteaReview>()
  for (const review of reviews) {
    const username = review.user?.login.trim().toLowerCase() ?? ''
    if (!username) {
      continue
    }
    const current = byUser.get(username)
    if (!current || isNewerReview(review, current)) {
      byUser.set(username, review)
    }
  }
  return [...byUser.values()]
}

export function giteaReviewersAndApproval(
  requestedReviewers: unknown,
  reviews: RawGiteaReview[]
): { reviewers: GiteaAssignableUser[]; approvalState: GiteaApprovalState } {
  const requested = (Array.isArray(requestedReviewers) ? requestedReviewers : []).flatMap(
    (entry) => {
      const reviewer = parseRequestedReviewer(entry)
      return reviewer ? [reviewer] : []
    }
  )
  const latest = latestGiteaReviewsByUser(reviews)
  const seen = new Set(requested.map((reviewer) => reviewer.username.toLowerCase()))
  const extras = latest
    .flatMap((review) => {
      const reviewer = userFromReview(review)
      if (!reviewer || seen.has(reviewer.username.toLowerCase())) {
        return []
      }
      return [reviewer]
    })
    .sort(byUsername)
  const approvedBy = latest
    .filter((review) => reviewState(review) === 'APPROVED' && !review.dismissed)
    .flatMap((review) => {
      const reviewer = userFromReview(review)
      return reviewer ? [reviewer] : []
    })
    .sort(byUsername)
  return {
    reviewers: [...requested, ...extras],
    approvalState: {
      approvedBy,
      changesRequested: latest.some(
        (review) => reviewState(review) === 'REQUEST_CHANGES' && !review.dismissed
      )
    }
  }
}
