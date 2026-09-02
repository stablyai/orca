import type {
  PRMergeableState,
  PRReviewDecision
} from '../../../../shared/github/pull-request-types'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import { summarizeProviderChecks } from '../../../../shared/provider-check-summary'
// Why: omit repoId — the main process only has the path; the renderer stamps repoId after IPC.
export type MainWorkItem = Omit<GitHubWorkItem, 'repoId'>

export const WORK_ITEM_PR_LIST_JSON_FIELDS =
  'number,title,state,url,labels,updatedAt,author,isDraft,headRefName,baseRefName,headRefOid,headRepositoryOwner,reviewRequests'

// Requested reviewers stay in the list payload because Tasks renders that column on first paint.
// Why: kept out of `gh pr list` — statusCheckRollup/reviewDecision/merge metadata fan out into expensive per-row GraphQL.
// Requested reviewers stay in the list payload because Tasks renders that column on first paint.
export const WORK_ITEM_PR_DETAIL_JSON_FIELDS =
  'number,title,state,url,labels,updatedAt,author,isDraft,headRefName,baseRefName,headRefOid,headRepositoryOwner,additions,deletions,changedFiles,reviewDecision,reviewRequests,latestReviews,assignees,statusCheckRollup,mergeable,mergeStateStatus,autoMergeRequest,maintainerCanModify'

/**
 * Derive author login + avatar_url together so GHE avatars render — the login-only
 * `{login}.png` URL 404s on GHE. REST uses `user.avatar_url`, gh/GraphQL `author.avatarUrl` (#8784).
 */
export function authorFieldsFromUnknown(
  item: Record<string, unknown>
): Pick<MainWorkItem, 'author' | 'authorAvatarUrl'> {
  const user = userFromUnknown(item.user ?? item.author)
  if (!user) {
    return { author: null }
  }
  return {
    author: user.login,
    ...(user.avatarUrl ? { authorAvatarUrl: user.avatarUrl } : {})
  }
}

export function extractHeadOwnerLogin(item: Record<string, unknown>): string | null {
  // gh CLI `pr list --json headRepositoryOwner` shape: { login }
  if (typeof item.headRepositoryOwner === 'object' && item.headRepositoryOwner !== null) {
    const login = (item.headRepositoryOwner as { login?: unknown }).login
    if (typeof login === 'string' && login.trim()) {
      return login
    }
  }
  // REST API `pull_request` shape: head.repo.owner.login
  if (typeof item.head === 'object' && item.head !== null) {
    const head = item.head as { repo?: unknown; user?: unknown; label?: unknown }
    const repo = head.repo
    if (typeof repo === 'object' && repo !== null) {
      const owner = (repo as { owner?: unknown }).owner
      if (typeof owner === 'object' && owner !== null) {
        const login = (owner as { login?: unknown }).login
        if (typeof login === 'string' && login.trim()) {
          return login
        }
      }
    }
    // Why: a deleted/inaccessible fork returns head.repo = null but still has head.user/head.label.
    const user = head.user
    if (typeof user === 'object' && user !== null) {
      const login = (user as { login?: unknown }).login
      if (typeof login === 'string' && login.trim()) {
        return login
      }
    }
    if (typeof head.label === 'string') {
      const owner = head.label.split(':', 1)[0]?.trim()
      if (owner) {
        return owner
      }
    }
  }
  return null
}

export function userFromUnknown(
  value: unknown
): { login: string; name: string | null; avatarUrl: string } | null {
  if (typeof value === 'string') {
    const login = value.trim()
    return login ? { login, name: null, avatarUrl: '' } : null
  }
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const raw = value as Record<string, unknown>
  const login = typeof raw.login === 'string' ? raw.login.trim() : ''
  if (!login) {
    return null
  }
  const databaseId = numberFromUnknown(raw.databaseId)
  return {
    login,
    name: typeof raw.name === 'string' ? raw.name : null,
    avatarUrl:
      typeof raw.avatarUrl === 'string'
        ? raw.avatarUrl
        : typeof raw.avatar_url === 'string'
          ? raw.avatar_url
          : databaseId !== undefined
            ? `https://avatars.githubusercontent.com/u/${databaseId}?v=4`
            : ''
  }
}

export function usersFromUnknown(
  value: unknown
): { login: string; name: string | null; avatarUrl: string }[] {
  if (!Array.isArray(value)) {
    return []
  }
  const users: { login: string; name: string | null; avatarUrl: string }[] = []
  for (const entry of value) {
    const direct = userFromUnknown(entry)
    if (direct) {
      users.push(direct)
      continue
    }
    if (typeof entry === 'object' && entry !== null) {
      const raw = entry as Record<string, unknown>
      const nested = userFromUnknown(raw.requestedReviewer ?? raw.user ?? raw.author)
      if (nested) {
        users.push(nested)
      }
    }
  }
  return users
}

export function latestReviewsFromUnknown(
  value: unknown
): NonNullable<GitHubWorkItem['latestReviews']> {
  if (!Array.isArray(value)) {
    return []
  }
  const reviews: NonNullable<GitHubWorkItem['latestReviews']> = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) {
      continue
    }
    const raw = entry as Record<string, unknown>
    const author = userFromUnknown(raw.author)
    if (!author) {
      continue
    }
    reviews.push({
      login: author.login,
      state: typeof raw.state === 'string' ? raw.state : null,
      avatarUrl: author.avatarUrl
    })
  }
  return reviews
}

export function numberFromUnknown(value: unknown): number | undefined {
  // Why: Number(null) is 0 — an explicit null must stay "unknown", not become a real count or user id.
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined
  }
  if (typeof value !== 'string' || !value.trim()) {
    return undefined
  }
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

export function normalizePRMergeable(value: unknown): PRMergeableState | undefined {
  const raw = typeof value === 'string' ? value.toUpperCase() : ''
  if (raw === 'MERGEABLE' || raw === 'CONFLICTING' || raw === 'UNKNOWN') {
    return raw
  }
  if (typeof value === 'boolean') {
    return value ? 'MERGEABLE' : 'CONFLICTING'
  }
  return undefined
}

export function normalizeReviewDecision(value: unknown): PRReviewDecision | null {
  return value === 'APPROVED' || value === 'CHANGES_REQUESTED' || value === 'REVIEW_REQUIRED'
    ? value
    : null
}

export function isAutoMergeEnabled(value: unknown): boolean {
  return typeof value === 'object' && value !== null
}

export function checkRollupEntries(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value
  }
  if (typeof value !== 'object' || value === null) {
    return []
  }
  const raw = value as Record<string, unknown>
  const nodes = (raw.contexts as { nodes?: unknown } | undefined)?.nodes
  return Array.isArray(nodes) ? nodes : []
}

export function deriveWorkItemCheckSummary(value: unknown): GitHubWorkItem['checksSummary'] {
  return summarizeProviderChecks(
    checkRollupEntries(value).map((entry) => {
      if (typeof entry !== 'object' || entry === null) {
        return { status: '', conclusion: '' }
      }
      const raw = entry as Record<string, unknown>
      // Why: StatusContext reports `state` and carries no `status`; CheckRun reports both.
      return {
        status: String(raw.status ?? ''),
        conclusion: String(raw.conclusion ?? raw.state ?? '')
      }
    })
  )
}
