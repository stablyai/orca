import {
  agentSessionFailureFact,
  providerDiagnostic
} from '../../../../shared/agent-session/failures/agent-session-failure'
import {
  usageLimitResetsAt,
  type AgentSessionUsageLimit,
  type AgentSessionUsageLimitWindow
} from '../../../../shared/agent-session/failures/agent-session-usage-limit'
import type { CodexRateLimitWindowsSnapshot } from '../../../rate-limits/providers/codex/codex-rate-limit-window-classification'
import {
  readCodexErrorAdditionalDetails,
  readCodexErrorInfo,
  readCodexErrorMessage
} from '../../app-server/codex-structured-thread-facts'

const RATE_LIMITS_UPDATED = 'notification:account/rateLimits/updated'
const USAGE_LIMIT_ERRORS = ['usageLimitExceeded', 'rateLimitExceeded']
/** The last report can trail a rejection by the request that went over, so a window this full counts as the spent one. */
const NEARLY_SPENT_PERCENT = 90
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
/** Codex's error text: "try again at 3:05 PM." today, else "try again at Jan 2nd, 2027 3:05 PM.",
 *  in its own local time and to the minute. */
const TRY_AGAIN_AT =
  /\btry again at (?:([a-z]{3}) (\d{1,2})(?:st|nd|rd|th), (\d{4}) )?(\d{1,2}):(\d{2}) ([ap]m)\./i

/** The reset Codex's error text names; undefined unless it reads exactly as a time still to come. */
export function codexUsageLimitResetFromText(text: string, now: number): number | undefined {
  const match = TRY_AGAIN_AT.exec(text)
  if (!match) {
    return undefined
  }
  const [, monthName, dayText, yearText, hourText, minuteText, meridiem] = match
  const hour = Number(hourText)
  const minute = Number(minuteText)
  if (hour < 1 || hour > 12 || minute > 59) {
    return undefined
  }
  const today = new Date(now)
  const month = monthName ? MONTHS.indexOf(monthName.toLowerCase()) : today.getMonth()
  const day = dayText ? Number(dayText) : today.getDate()
  const year = yearText ? Number(yearText) : today.getFullYear()
  const at = new Date(
    year,
    month,
    day,
    (hour % 12) + (meridiem.toLowerCase() === 'pm' ? 12 : 0),
    minute
  )
  if (month < 0 || at.getMonth() !== month || at.getDate() !== day) {
    return undefined
  }
  // The text drops seconds; the end of its minute is never before the real reset.
  const reset = at.getTime() + 60_000
  return reset > now ? usageLimitResetsAt(reset, now) : undefined
}

type CodexAccountRateLimits = CodexRateLimitWindowsSnapshot & {
  rateLimitReachedType?: unknown
  planType?: unknown
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? { ...value } : null
}

export class CodexUsageLimits {
  private snapshot: CodexAccountRateLimits = {}

  constructor(private readonly now: () => number = Date.now) {}

  /** Consume usage reports without journaling them as generic frames. */
  observe(kind: string, payload: unknown): boolean {
    if (kind !== RATE_LIMITS_UPDATED) {
      return false
    }
    const update = record(record(payload)?.rateLimits)
    // Model-specific buckets do not describe the account's session or weekly limits.
    if (update && (update.limitId == null || update.limitId === 'codex')) {
      // Reports may omit unchanged fields.
      this.snapshot = {
        ...this.snapshot,
        ...Object.fromEntries(Object.entries(update).filter(([, value]) => value !== undefined))
      }
    }
    return true
  }

  failure(payload: unknown) {
    const info = readCodexErrorInfo(payload)
    if (
      !info ||
      (!USAGE_LIMIT_ERRORS.includes(info.error) &&
        !(info.error === 'responseTooManyFailedAttempts' && info.status === 429))
    ) {
      return null
    }
    const message = readCodexErrorMessage(payload)
    const additional = readCodexErrorAdditionalDetails(payload)
    const text = [message, additional && additional !== message ? additional : null]
      .filter((part): part is string => part !== null)
      .join('\n')
    const limit = this.limit(info.error === 'usageLimitExceeded', text)
    return agentSessionFailureFact('usageLimitReached', {
      ...(limit ? { usageLimit: limit } : {}),
      detail: providerDiagnostic(text, 'person')
    })
  }

  /** All spent windows must reset; report the latest only if every reset is known. */
  private limit(rejected: boolean, text: string): AgentSessionUsageLimit | null {
    const monthlyPlan = this.snapshot.planType === 'free' || this.snapshot.planType === 'go'
    const reported = (
      [
        ['primary', monthlyPlan ? 43200 : 300],
        ['secondary', 10080]
      ] as const
    ).flatMap(([position, fallback]) => {
      const raw = this.snapshot[position]
      if (!raw || typeof raw.usedPercent !== 'number' || !Number.isFinite(raw.usedPercent)) {
        return []
      }
      const duration =
        raw.windowDurationMins === undefined || raw.windowDurationMins === null
          ? fallback
          : raw.windowDurationMins
      const window =
        typeof duration === 'number' && Number.isFinite(duration) && duration > 0
          ? duration >= 43200
            ? undefined
            : duration >= 10080
              ? ('weekly' as const)
              : ('session' as const)
          : undefined
      return [{ window, resetsAt: raw.resetsAt, usedPercent: raw.usedPercent }]
    })
    // A window that already reset cannot be the one that just rejected.
    const live = reported.filter(
      (entry) => typeof entry.resetsAt !== 'number' || entry.resetsAt * 1000 > this.now()
    )
    const fullest = Math.max(...live.map((entry) => entry.usedPercent))
    const spent =
      rejected &&
      fullest >= NEARLY_SPENT_PERCENT &&
      !reported.some((entry) => entry.usedPercent >= 100)
        ? live.filter((entry) => entry.usedPercent >= fullest)
        : reported.filter((entry) => entry.usedPercent >= 100)
    const reached = this.snapshot.rateLimitReachedType
    const credits = typeof reached === 'string' && reached.endsWith('credits_depleted')
    const window: AgentSessionUsageLimitWindow | undefined = credits
      ? 'credits'
      : spent.length === 1
        ? spent[0]?.window
        : undefined
    const resets = spent.flatMap((entry) =>
      typeof entry.resetsAt === 'number' ? [entry.resetsAt * 1000] : []
    )
    // Without a full report, the time the error itself names; the report wins when it has one.
    const resetsAt =
      (resets.length > 0 && resets.length === spent.length
        ? usageLimitResetsAt(Math.max(...resets), this.now())
        : undefined) ?? codexUsageLimitResetFromText(text, this.now())
    return window || resetsAt
      ? { ...(window ? { window } : {}), ...(resetsAt ? { resetsAt } : {}) }
      : null
  }
}
