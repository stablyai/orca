import type { InactiveAccountUsage, ProviderRateLimits } from '../../shared/rate-limit-types'

const CLAUDE_AUTO_SWITCH_THRESHOLD_PERCENT = 90
// Why: a switch only reaches the next Claude started, so a fresh pick needs time to be used.
export const CLAUDE_AUTO_SWITCH_COOLDOWN_MS = 5 * 60_000
// Why: an account only a few points under the line would cross it again within minutes.
const MIN_PERCENT_GAINED = 10

/** The tightest 5-hour or weekly window still running (0 once both reset), or null when usage could not be read. */
function getClaudeUsedPercent(limits: ProviderRateLimits | null, now: number): number | null {
  if (limits?.status !== 'ok') {
    return null
  }
  const windows = [limits.session, limits.weekly].filter((window) => window !== null)
  if (windows.length === 0) {
    return null
  }
  // Why: a window past its reset has started over, yet an idle session still reports its old usage.
  const current = windows.filter((window) => window.resetsAt === null || window.resetsAt > now)
  return Math.max(0, ...current.map((window) => window.usedPercent))
}

export function isClaudeOverAutoSwitchLine(
  limits: ProviderRateLimits | null,
  now: number
): boolean {
  return (getClaudeUsedPercent(limits, now) ?? 0) >= CLAUDE_AUTO_SWITCH_THRESHOLD_PERCENT
}

/** The account new Claude sessions should move to, or null to stay. */
export function pickClaudeAutoSwitchTarget(
  active: ProviderRateLimits | null,
  candidates: InactiveAccountUsage[],
  { now, lastSwitchAt }: { now: number; lastSwitchAt: number }
): string | null {
  const used = getClaudeUsedPercent(active, now)
  if (used === null || used < CLAUDE_AUTO_SWITCH_THRESHOLD_PERCENT) {
    return null
  }
  const atLimit = used >= 100
  if (!atLimit && now - lastSwitchAt < CLAUDE_AUTO_SWITCH_COOLDOWN_MS) {
    return null
  }
  const best = candidates
    .flatMap((candidate) => {
      const candidateUsed = getClaudeUsedPercent(candidate.rateLimits, now)
      return candidateUsed !== null && candidateUsed < 100
        ? [{ accountId: candidate.accountId, used: candidateUsed }]
        : []
    })
    .sort((a, b) => a.used - b.used)[0]
  if (!best) {
    return null
  }
  // Why: at the limit the agent stops anyway, so any account with room beats staying.
  if (atLimit) {
    return best.accountId
  }
  const clearlyBetter =
    best.used < CLAUDE_AUTO_SWITCH_THRESHOLD_PERCENT && best.used <= used - MIN_PERCENT_GAINED
  return clearlyBetter ? best.accountId : null
}
