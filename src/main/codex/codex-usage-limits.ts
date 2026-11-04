import {
  agentSessionFailureFact,
  providerDiagnostic
} from '../../shared/agent-session/failures/agent-session-failure'
import { codexUsageLimit } from '../../shared/agent-session/failures/provider-usage-limit'
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
    const limit = codexUsageLimit(this.snapshot, this.now())
    return agentSessionFailureFact('usageLimitReached', {
      ...(limit ? { usageLimit: limit } : {}),
      detail: providerDiagnostic(text, 'person')
    })
  }
}
