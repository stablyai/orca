import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import { parseClaudeUsageResetTimestamp } from './claude-usage-window'

type ClaudeResetCredits = NonNullable<ProviderRateLimits['rateLimitResetCredits']>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}

function readTimestamp(value: unknown): number | null {
  return typeof value === 'string' || typeof value === 'number'
    ? parseClaudeUsageResetTimestamp(value)
    : null
}

let warnedStaleCliVersion = false

// Why: the server hides resets from a User-Agent below its minimum CLI version, which would
// otherwise only look like an account with no resets.
export function warnIfClaudeResetsNeedNewerCli(raw: unknown, userAgent: string): void {
  if (warnedStaleCliVersion || !isRecord(raw) || raw.ineligible_reason !== 'cli_version') {
    return
  }
  warnedStaleCliVersion = true
  console.warn(
    `[claude-rate-limits] Claude hides usage-limit resets for User-Agent "${userAgent}"; bump CLAUDE_CLI_USER_AGENT in claude-oauth-usage-request.ts to a current Claude Code version.`
  )
}

export function resetClaudeResetGrantWarningsForTests(): void {
  warnedStaleCliVersion = false
}

/**
 * Maps the usage response's `cedar_ember` block (Claude's earned usage-limit resets) onto the
 * provider-neutral reset-credit shape. Returns null for anything but an eligible, well-formed
 * block so an unexpected payload hides the row instead of showing a count we never received.
 */
export function mapClaudeResetGrants(raw: unknown, now = Date.now()): ClaudeResetCredits | null {
  if (!isRecord(raw) || raw.eligible !== true || !Array.isArray(raw.grants)) {
    return null
  }

  const credits: NonNullable<ClaudeResetCredits['credits']> = []
  let availableCount = 0
  let totalEarnedCount = 0
  let nextExpiresAt: number | null = null

  for (const grant of raw.grants) {
    if (!isRecord(grant)) {
      continue
    }
    const resetsLeft = readCount(grant.resets_left)
    if (resetsLeft === null) {
      continue
    }
    totalEarnedCount += readCount(grant.resets_total) ?? resetsLeft
    const expiresAt = readTimestamp(grant.ends_at)
    const grantedAt = readTimestamp(grant.starts_at)
    const paused = grant.paused === true
    const expired = expiresAt !== null && expiresAt <= now
    // Why: `usable_now` is redeem-time gating (cooldown, at-limit rules), not ownership, so only
    // a grant that hasn't started yet is left out of what the user holds.
    const scheduled = grantedAt !== null && grantedAt > now
    credits.push({
      status: expired
        ? 'expired'
        : paused
          ? 'paused'
          : scheduled
            ? 'scheduled'
            : resetsLeft > 0
              ? 'available'
              : 'used',
      expiresAt,
      grantedAt
    })
    if (paused || expired || scheduled || resetsLeft === 0) {
      continue
    }
    availableCount += resetsLeft
    if (expiresAt !== null && (nextExpiresAt === null || expiresAt < nextExpiresAt)) {
      nextExpiresAt = expiresAt
    }
  }

  // Why: grants we couldn't read give no count, so hide the row rather than claim zero.
  if (raw.grants.length > 0 && credits.length === 0) {
    return null
  }
  return { availableCount, totalEarnedCount, nextExpiresAt, credits }
}
