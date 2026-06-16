import type {
  CheckStatus,
  GitHubAssignableUser,
  GitHubPRCheckSummary,
  GitHubPRReviewSummary,
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
  const login = readString(value.login)
  if (login === undefined) {
    return null
  }
  return {
    login,
    state: readString(value.state) ?? null,
    avatarUrl: readString(value.avatarUrl) ?? null
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
