// Backoff lane for issue #9705: when the branch-name generator hits the agent's
// session/usage limit, later first-work events must wait out the limit instead
// of retrying on every assistant message.
import type { AgentGenerationFailureOutput } from '../text-generation/agent-failure-output'

// Known agent CLI limit responses, e.g. Claude's "hit your session limit · resets 2pm"
// and "Claude AI usage limit reached|<epoch>".
const USAGE_LIMIT_PATTERN =
  /hit your (?:session|usage) limit|(?:session|usage|weekly|\d+-hour|\d+-day) limit reached/i

export const USAGE_LIMIT_DEFAULT_BACKOFF_MS = 15 * 60_000
// Cap so a misparsed reset time can only pause the convenience feature, never freeze it.
export const USAGE_LIMIT_MAX_BACKOFF_MS = 24 * 60 * 60_000
const MIN_BACKOFF_MS = 60_000

// Why module-global (not per-worktree): the limit is per agent account, so one
// limited response means every worktree's generation attempt would fail too.
let backoffUntilMs = 0

/** Test seam. */
export function resetUsageLimitBackoffState(): void {
  backoffUntilMs = 0
}

export function usageLimitBackoffRemainingMs(now: number = Date.now()): number {
  return Math.max(0, backoffUntilMs - now)
}

/**
 * Inspect a failed generation result; when it is a usage/session-limit
 * response, arm the backoff (until the stated reset time when parseable,
 * else a fixed delay). Returns the backoff deadline, or null when the
 * failure is unrelated to limits.
 */
export function noteGenerationFailureForUsageLimit(
  error: string,
  failureOutput: AgentGenerationFailureOutput | null | undefined,
  now: number = Date.now()
): number | null {
  const matched = [error, failureOutput?.stdout, failureOutput?.stderr].find(
    (text) => text !== undefined && USAGE_LIMIT_PATTERN.test(text)
  )
  if (matched === undefined) {
    return null
  }
  const parsed = parseResetDelayMs(matched, now)
  const backoff = Math.min(
    Math.max(parsed ?? USAGE_LIMIT_DEFAULT_BACKOFF_MS, MIN_BACKOFF_MS),
    USAGE_LIMIT_MAX_BACKOFF_MS
  )
  backoffUntilMs = Math.max(backoffUntilMs, now + backoff)
  return backoffUntilMs
}

/** Delay until the reset time stated in the limit message, or null when absent/unparseable. */
function parseResetDelayMs(text: string, now: number): number | null {
  // API-style "usage limit reached|<epoch seconds or ms>".
  const epoch = /limit reached\|(\d{10,13})/.exec(text)
  if (epoch) {
    const at = epoch[1].length >= 13 ? Number(epoch[1]) : Number(epoch[1]) * 1000
    const delay = at - now
    return delay > 0 ? delay : null
  }
  // CLI-style "resets 2pm", "resets at 2:30pm", "resets 14:00". A trailing IANA
  // zone (e.g. "(Europe/Madrid)") is ignored — interpreted as local time, which
  // the cap bounds even when the zones disagree.
  const clock = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(text)
  if (!clock) {
    return null
  }
  let hour = Number(clock[1])
  const minute = clock[2] === undefined ? 0 : Number(clock[2])
  const meridiem = clock[3]?.toLowerCase()
  if (!meridiem && clock[2] === undefined) {
    // A bare number without am/pm or minutes (e.g. "resets 2") is too ambiguous.
    return null
  }
  if (meridiem === 'pm' && hour < 12) {
    hour += 12
  }
  if (meridiem === 'am' && hour === 12) {
    hour = 0
  }
  if (hour > 23 || minute > 59) {
    return null
  }
  const reset = new Date(now)
  reset.setHours(hour, minute, 0, 0)
  let delay = reset.getTime() - now
  if (delay <= 0) {
    delay += 24 * 60 * 60_000
  }
  return delay
}
