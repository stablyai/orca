import { agentSessionFailureFact, providerDiagnostic } from '../../shared/agent-session-failure'
import {
  usageLimitResetsAt,
  type AgentSessionUsageLimit,
  type AgentSessionUsageLimitWindow
} from '../../shared/agent-session-usage-limit'
import type { CodexRateLimitWindowsSnapshot } from '../rate-limits/codex-rate-limit-window-classification'
import {
  readCodexErrorAdditionalDetails,
  readCodexErrorInfo,
  readCodexErrorMessage
} from './codex-structured-thread-facts'

const RATE_LIMITS_UPDATED = 'notification:account/rateLimits/updated'
const USAGE_LIMIT_ERRORS = ['usageLimitExceeded', 'rateLimitExceeded']

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
    const error = readCodexErrorInfo(payload)?.error
    if (!error || !USAGE_LIMIT_ERRORS.includes(error)) {
      return null
    }
    const message = readCodexErrorMessage(payload)
    const additional = readCodexErrorAdditionalDetails(payload)
    const text = [message, additional && additional !== message ? additional : null]
      .filter((part): part is string => part !== null)
      .join('\n')
    const limit = this.limit()
    return agentSessionFailureFact('usageLimitReached', {
      ...(limit ? { usageLimit: limit } : {}),
      detail: providerDiagnostic(text, 'person')
    })
  }

  /** All spent windows must reset; report the latest only if every reset is known. */
  private limit(): AgentSessionUsageLimit | null {
    const monthlyPlan = this.snapshot.planType === 'free' || this.snapshot.planType === 'go'
    const spent = (
      [
        ['primary', monthlyPlan ? 43200 : 300],
        ['secondary', 10080]
      ] as const
    ).flatMap(([position, fallback]) => {
      const raw = this.snapshot[position]
      if (
        !raw ||
        typeof raw.usedPercent !== 'number' ||
        !Number.isFinite(raw.usedPercent) ||
        raw.usedPercent < 100
      ) {
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
      return [{ window, resetsAt: raw.resetsAt }]
    })
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
    const resetsAt =
      resets.length > 0 && resets.length === spent.length
        ? usageLimitResetsAt(Math.max(...resets), this.now())
        : undefined
    return window || resetsAt
      ? { ...(window ? { window } : {}), ...(resetsAt ? { resetsAt } : {}) }
      : null
  }
}
