import type {
  CheckStatus,
  GitHubAssignableUser,
  GitHubPRCheckSummary,
  GitHubPRMergeMethod,
  GitHubPRMergeMethodSettings,
  GitHubPRReviewSummary,
  GitHubRepositoryIdentity,
  PRCheckDetail,
  PRMergeableState,
  PRReviewDecision,
  PRState
} from '../../../src/shared/types'
import type { HostedReviewProvider } from '../../../src/shared/hosted-review'

// Primitive + enum value readers shared by the github.* PR parsers. Each narrows
// `unknown` defensively (never throws) so RPC payloads can be parsed safely.

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

export function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.flatMap((entry): string[] => {
    const str = readString(entry)
    return str === undefined ? [] : [str]
  })
}

export function readProvider(value: unknown): HostedReviewProvider | undefined {
  return value === 'github' ||
    value === 'gitlab' ||
    value === 'bitbucket' ||
    value === 'azure-devops' ||
    value === 'gitea' ||
    value === 'unsupported'
    ? value
    : undefined
}

export function readPRState(value: unknown): PRState | null {
  return value === 'open' || value === 'closed' || value === 'merged' || value === 'draft'
    ? value
    : null
}

export function readCheckStatus(value: unknown): CheckStatus {
  return value === 'pending' || value === 'success' || value === 'failure' || value === 'neutral'
    ? value
    : 'pending'
}

export function readMergeableState(value: unknown): PRMergeableState | undefined {
  return value === 'MERGEABLE' || value === 'CONFLICTING' || value === 'UNKNOWN' ? value : undefined
}

export function readReviewDecision(value: unknown): PRReviewDecision | null | undefined {
  if (value === null) {
    return null
  }
  return value === 'APPROVED' || value === 'CHANGES_REQUESTED' || value === 'REVIEW_REQUIRED'
    ? value
    : undefined
}

export function readCheckRunStatus(value: unknown): PRCheckDetail['status'] | null {
  return value === 'queued' || value === 'in_progress' || value === 'completed' ? value : null
}

export function readCheckRunConclusion(value: unknown): PRCheckDetail['conclusion'] {
  return value === 'success' ||
    value === 'failure' ||
    value === 'cancelled' ||
    value === 'timed_out' ||
    value === 'neutral' ||
    value === 'skipped' ||
    value === 'pending'
    ? value
    : null
}

export function readAssignableUser(value: unknown): GitHubAssignableUser | null {
  if (!isRecord(value)) {
    return null
  }
  const login = readString(value.login)
  if (login === undefined) {
    return null
  }
  return {
    login,
    name: readString(value.name) ?? null,
    avatarUrl: readString(value.avatarUrl) ?? ''
  }
}

export function readAssignableUserArray(value: unknown): GitHubAssignableUser[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.flatMap((entry): GitHubAssignableUser[] => {
    const parsed = readAssignableUser(entry)
    return parsed ? [parsed] : []
  })
}

export function readReviewSummary(value: unknown): GitHubPRReviewSummary | null {
  if (!isRecord(value)) {
    return null
  }
  // Desktop maps latestReviews to top-level `login`. Raw `gh pr view --json`
  // keeps nested `author.login` — accept both so mobile never drops reviewers.
  const nestedAuthor = isRecord(value.author) ? value.author : null
  const login =
    readString(value.login) ?? (nestedAuthor ? readString(nestedAuthor.login) : undefined)
  if (login === undefined) {
    return null
  }
  const avatarUrl =
    readString(value.avatarUrl) ??
    (nestedAuthor
      ? (readString(nestedAuthor.avatarUrl) ?? readString(nestedAuthor.avatar_url) ?? null)
      : null)
  return {
    login,
    state: readString(value.state) ?? null,
    avatarUrl
  }
}

export function readRepoIdentity(value: unknown): GitHubRepositoryIdentity | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  const owner = readString(value.owner)
  const repo = readString(value.repo)
  // Empty owner/repo is malformed, not a valid identity — drop it before it reaches prRepo parsing.
  if (!owner || !repo) {
    return undefined
  }
  return { owner, repo }
}

function readMergeMethod(value: unknown): GitHubPRMergeMethod | undefined {
  return value === 'merge' || value === 'squash' || value === 'rebase' ? value : undefined
}

export function readMergeMethodSettings(value: unknown): GitHubPRMergeMethodSettings | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  const defaultMethod = readMergeMethod(value.defaultMethod)
  if (defaultMethod === undefined || !isRecord(value.allowedMethods)) {
    return undefined
  }
  const allowed = value.allowedMethods
  return {
    defaultMethod,
    allowedMethods: {
      merge: readBoolean(allowed.merge) ?? false,
      squash: readBoolean(allowed.squash) ?? false,
      rebase: readBoolean(allowed.rebase) ?? false
    }
  }
}

export function readCheckSummary(value: unknown): GitHubPRCheckSummary | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  const state = value.state
  if (state !== 'success' && state !== 'failure' && state !== 'pending' && state !== 'none') {
    return undefined
  }
  return {
    state,
    total: readNumber(value.total) ?? 0,
    passed: readNumber(value.passed) ?? 0,
    failed: readNumber(value.failed) ?? 0,
    pending: readNumber(value.pending) ?? 0
  }
}
