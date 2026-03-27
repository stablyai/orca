import type { PRInfo, IssueInfo, CheckStatus, PRCheckDetail } from '../../shared/types'

// ── REST API check-runs mapping ───────────────────────────────────────
// The REST check-runs endpoint returns separate status + conclusion fields
// (unlike gh pr checks which merges them into a single "state" string).

export function mapCheckRunRESTStatus(status: string): PRCheckDetail['status'] {
  const s = status?.toLowerCase()
  if (s === 'queued') {
    return 'queued'
  }
  if (s === 'in_progress') {
    return 'in_progress'
  }
  return 'completed'
}

const conclusionMap: Record<string, PRCheckDetail['conclusion']> = {
  success: 'success',
  failure: 'failure',
  cancelled: 'cancelled',
  timed_out: 'timed_out',
  skipped: 'skipped',
  neutral: 'neutral',
  action_required: 'failure'
}

export function mapCheckRunRESTConclusion(
  status: string,
  conclusion: string | null
): PRCheckDetail['conclusion'] {
  if (status?.toLowerCase() !== 'completed') {
    return 'pending'
  }
  if (!conclusion) {
    return null
  }
  return conclusionMap[conclusion.toLowerCase()] ?? null
}

// ── gh pr checks mapping (single "state" string) ─────────────────────

export function mapCheckStatus(state: string): PRCheckDetail['status'] {
  const s = state?.toUpperCase()
  if (s === 'PENDING' || s === 'QUEUED') {
    return 'queued'
  }
  if (s === 'IN_PROGRESS') {
    return 'in_progress'
  }
  return 'completed'
}

export function mapCheckConclusion(state: string): PRCheckDetail['conclusion'] {
  const s = state?.toUpperCase()
  if (s === 'SUCCESS' || s === 'PASS') {
    return 'success'
  }
  if (s === 'FAILURE' || s === 'FAIL') {
    return 'failure'
  }
  if (s === 'CANCELLED') {
    return 'cancelled'
  }
  if (s === 'TIMED_OUT') {
    return 'timed_out'
  }
  if (s === 'SKIPPED') {
    return 'skipped'
  }
  if (s === 'PENDING' || s === 'QUEUED' || s === 'IN_PROGRESS') {
    return 'pending'
  }
  if (s === 'NEUTRAL') {
    return 'neutral'
  }
  return null
}

export function mapPRState(state: string, isDraft?: boolean): PRInfo['state'] {
  const s = state?.toUpperCase()
  if (s === 'MERGED') {
    return 'merged'
  }
  if (s === 'CLOSED') {
    return 'closed'
  }
  if (isDraft) {
    return 'draft'
  }
  return 'open'
}

// ── Issue mapping ────────────────────────────────────────────────────
// REST API returns html_url + lowercase state; gh issue view returns url + mixed-case state.
// This helper normalises both shapes into IssueInfo.

export function mapIssueInfo(data: {
  number: number
  title: string
  state: string
  url?: string
  html_url?: string
  labels?: { name: string }[]
}): IssueInfo {
  return {
    number: data.number,
    title: data.title,
    state: data.state?.toLowerCase() === 'open' ? 'open' : 'closed',
    url: data.html_url ?? data.url ?? '',
    labels: (data.labels || []).map((l) => l.name)
  }
}

export function deriveCheckStatus(rollup: unknown[] | null | undefined): CheckStatus {
  if (!rollup || !Array.isArray(rollup) || rollup.length === 0) {
    return 'neutral'
  }

  let hasFailure = false
  let hasPending = false

  for (const check of rollup as { status?: string; conclusion?: string; state?: string }[]) {
    const conclusion = check.conclusion?.toUpperCase()
    const status = check.status?.toUpperCase()
    const state = check.state?.toUpperCase()

    if (
      conclusion === 'FAILURE' ||
      conclusion === 'TIMED_OUT' ||
      conclusion === 'CANCELLED' ||
      state === 'FAILURE' ||
      state === 'ERROR'
    ) {
      hasFailure = true
    } else if (
      status === 'IN_PROGRESS' ||
      status === 'QUEUED' ||
      status === 'PENDING' ||
      state === 'PENDING'
    ) {
      hasPending = true
    }
  }

  if (hasFailure) {
    return 'failure'
  }
  if (hasPending) {
    return 'pending'
  }
  return 'success'
}
