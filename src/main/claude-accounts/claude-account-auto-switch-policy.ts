import type {
  InactiveAccountUsage,
  ProviderRateLimits,
  RateLimitWindow
} from '../../shared/rate-limit-types'

// Lines: the 5-hour window at 95 %, the weekly and the Fable-weekly windows at 90 %.
export const CLAUDE_AUTO_SWITCH_LINES = { session: 95, weekly: 90, fableWeekly: 90 } as const
// Why: a switch only reaches the next Claude started, so a fresh pick needs time to be used.
export const CLAUDE_AUTO_SWITCH_COOLDOWN_MS = 5 * 60_000
// Why: an account only a few points under a line would cross it again within minutes.
const MIN_HEADROOM_GAINED = 10

type WindowName = keyof typeof CLAUDE_AUTO_SWITCH_LINES
type LiveWindow = { name: WindowName; used: number; line: number }

/**
 * The windows the account reports, each with its own line. A window past its reset has
 * started over, yet an idle session still reports its old usage — so it counts as empty.
 * Null when usage could not be read (status not ok, or no window at all).
 */
function liveWindows(limits: ProviderRateLimits | null, now: number): LiveWindow[] | null {
  if (limits?.status !== 'ok') {
    return null
  }
  const pairs: [WindowName, RateLimitWindow | null | undefined][] = [
    ['session', limits.session],
    ['weekly', limits.weekly],
    ['fableWeekly', limits.fableWeekly]
  ]
  const present = pairs.filter(
    (pair): pair is [WindowName, RateLimitWindow] => pair[1] !== null && pair[1] !== undefined
  )
  if (present.length === 0) {
    return null
  }
  return present.map(([name, window]) => ({
    name,
    used: window.resetsAt !== null && window.resetsAt <= now ? 0 : window.usedPercent,
    line: CLAUDE_AUTO_SWITCH_LINES[name]
  }))
}

/** Distance to the nearest line over the account's windows (negative = over), or null when usage could not be read. */
export function claudeAutoSwitchHeadroom(
  limits: ProviderRateLimits | null,
  now: number
): number | null {
  const live = liveWindows(limits, now)
  if (!live) {
    return null
  }
  return Math.min(...live.map((window) => window.line - window.used))
}

export function isClaudeOverAutoSwitchLine(
  limits: ProviderRateLimits | null,
  now: number
): boolean {
  const headroom = claudeAutoSwitchHeadroom(limits, now)
  return headroom !== null && headroom <= 0
}

function isAtLimit(limits: ProviderRateLimits | null, now: number): boolean {
  return (liveWindows(limits, now) ?? []).some((window) => window.used >= 100)
}

/** The account new Claude sessions should move to, or null to stay. */
export function pickClaudeAutoSwitchTarget(
  active: ProviderRateLimits | null,
  candidates: InactiveAccountUsage[],
  { now, lastSwitchAt }: { now: number; lastSwitchAt: number }
): string | null {
  const activeHeadroom = claudeAutoSwitchHeadroom(active, now)
  if (activeHeadroom === null || activeHeadroom > 0) {
    return null
  }
  const atLimit = isAtLimit(active, now)
  if (!atLimit && now - lastSwitchAt < CLAUDE_AUTO_SWITCH_COOLDOWN_MS) {
    return null
  }
  const best = candidates
    .flatMap((candidate) => {
      const headroom = claudeAutoSwitchHeadroom(candidate.rateLimits, now)
      return headroom !== null && !isAtLimit(candidate.rateLimits, now)
        ? [{ accountId: candidate.accountId, headroom }]
        : []
    })
    .sort((a, b) => b.headroom - a.headroom)[0]
  if (!best) {
    return null
  }
  // Why: at the limit the agent stops anyway, so any account with room beats staying.
  if (atLimit) {
    return best.headroom > 0 ? best.accountId : null
  }
  return best.headroom >= MIN_HEADROOM_GAINED ? best.accountId : null
}

export type ClaudeAutoSwitchWindowName = WindowName
export type ClaudeAutoSwitchWindow = LiveWindow
// Why exported: the session mover decides per session with the same windows, lines and limit test.
export { liveWindows as claudeAutoSwitchWindows, isAtLimit as isClaudeAtLimit }
