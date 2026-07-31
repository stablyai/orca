export type GitHubCheckLike = {
  status: string
  conclusion?: string | null
}

export type GitHubCheckSummary = {
  state: 'success' | 'failure' | 'pending' | 'neutral' | 'none'
  total: number
  passed: number
  failed: number
  pending: number
  neutral: number
}

function isFailedCheck(check: GitHubCheckLike): boolean {
  return (
    check.conclusion === 'failure' ||
    check.conclusion === 'timed_out' ||
    check.conclusion === 'cancelled'
  )
}

function isPendingCheck(check: GitHubCheckLike): boolean {
  return (
    check.status === 'queued' || check.status === 'in_progress' || check.conclusion === 'pending'
  )
}

export function buildGitHubCheckSummary(checks: GitHubCheckLike[]): GitHubCheckSummary {
  let failed = 0
  let pending = 0
  let neutral = 0

  for (const check of checks) {
    if (isFailedCheck(check) || check.conclusion === 'action_required') {
      failed += 1
    } else if (isPendingCheck(check)) {
      pending += 1
    } else if (check.conclusion === 'success') {
      continue
    } else {
      neutral += 1
    }
  }

  const total = checks.length
  const passed = total - failed - pending - neutral
  const state =
    total === 0
      ? 'none'
      : failed > 0
        ? 'failure'
        : pending > 0
          ? 'pending'
          : neutral > 0
            ? 'neutral'
            : 'success'

  return { state, total, passed, failed, pending, neutral }
}
