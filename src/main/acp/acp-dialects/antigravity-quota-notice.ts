import { ANTIGRAVITY_QUOTA_WORDS } from '../../../shared/agent-accounts/antigravity/antigravity-quota-words'
import { usageLimitResetsAt } from '../../../shared/agent-session/failures/agent-session-usage-limit'
import type { AcpTurnEnding } from './acp-dialect'

// agy's notice lines, e.g. "<warning sign> Individual quota reached. Please upgrade your
// subscription to increase your limits. Resets in 2h30m0s." The bundle must stay ASCII, so the
// sign is escaped. Only these leads are agy's: other warning prose naming quota is the model's.
const QUOTA_NOTICE_LEAD =
  /^\u26a0 (?:Individual quota reached|You have exhausted your (?:quota|capacity) on this model)\b/
// agy's lines are far shorter; a longer chunk is the model's reply.
const MAX_NOTICE_LENGTH = 2_048

/** A reply chunk that is wholly agy's notice that the account or model ran out of quota. */
export function isAntigravityQuotaNotice(text: string): boolean {
  if (text.length > MAX_NOTICE_LENGTH) {
    return false
  }
  const line = text.trim()
  return !line.includes('\n') && QUOTA_NOTICE_LEAD.test(line)
}

// agy's "Resets in", Google's "reset after" and "Please retry in" lead the wait.
const RESET_LEAD = /\b(?:resets? (?:in|after)|retry in)\s+/i
// One "2h", "30m0s" or "3 hours, and 5 minutes" part; longer unit names before shorter ones.
const PART =
  /^(\d{1,9}(?:\.\d{1,12})?)\s*(milliseconds?|ms|days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?![a-z])(?:\s*,)?(?:\s*and)?\s*/i
const UNIT_MS: Record<string, number> = { ms: 1, d: 86_400_000, h: 3_600_000, m: 60_000, s: 1_000 }
const MAX_PARTS = 6

function unitMs(unit: string): number {
  const lower = unit.toLowerCase()
  if (lower === 'ms' || lower.startsWith('milli')) {
    return UNIT_MS.ms
  }
  if (lower.startsWith('mi') || lower === 'm') {
    return UNIT_MS.m
  }
  return UNIT_MS[lower[0]]
}

/** The wait a notice names after its reset lead, in ms; undefined when it names none. */
export function antigravityQuotaWaitMs(text: string): number | undefined {
  const lead = RESET_LEAD.exec(text)
  if (!lead) {
    return undefined
  }
  let rest = text.slice(lead.index + lead[0].length)
  let total = 0
  let parts = 0
  for (let part = PART.exec(rest); part && parts < MAX_PARTS; part = PART.exec(rest)) {
    total += Number(part[1]) * unitMs(part[2])
    parts += 1
    rest = rest.slice(part[0].length)
  }
  return parts > 0 && Number.isFinite(total) ? total : undefined
}

/** A quota failure as the turn's ending: a usage limit, its relative reset made absolute against
 *  `at`, when it was observed. Undefined for words that name no quota. */
export function antigravityQuotaFailure(
  words: string,
  at: number
): Pick<AcpTurnEnding, 'stopReason' | 'usageLimit'> | undefined {
  if (!ANTIGRAVITY_QUOTA_WORDS.test(words)) {
    return undefined
  }
  const wait = antigravityQuotaWaitMs(words)
  const resetsAt = wait === undefined ? undefined : usageLimitResetsAt(Math.round(at + wait), at)
  return {
    stopReason: 'rate_limit',
    ...(resetsAt === undefined ? {} : { usageLimit: { resetsAt } })
  }
}
