import type {
  AgentJournalStatusItem,
  AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import {
  boundInlineText,
  DEFAULT_JOURNAL_PAYLOAD_LIMITS
} from '../native-chat/agent-session-journal/journal-payload-bounds'

type RetryFrame = {
  attempt: number
  maxRetries: number
  errorStatus: number | null
  error: string
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
}

function nonnegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}

function retryFrame(message: Record<string, unknown>): RetryFrame | null {
  if (message.type !== 'system' || message.subtype !== 'api_retry') {
    return null
  }
  const attempt = positiveInteger(message.attempt)
  const maxRetries = nonnegativeInteger(message.max_retries)
  if (attempt === null || maxRetries === null || typeof message.error !== 'string') {
    return null
  }
  return {
    attempt,
    maxRetries,
    errorStatus:
      message.error_status === null || typeof message.error_status === 'number'
        ? message.error_status
        : null,
    error: message.error
  }
}

function category(code: number | null, message: string): string | null {
  const normalized = message.toLowerCase()
  if (code === 529 || normalized.includes('overload')) {
    return 'overloaded'
  }
  if (code === 429 || normalized.includes('rate_limit') || normalized.includes('rate limit')) {
    return 'rate-limited'
  }
  if ((code !== null && code >= 500) || normalized.includes('server_error')) {
    return 'unavailable'
  }
  if (normalized.includes('timeout') || normalized.includes('connection')) {
    return 'network'
  }
  return null
}

function statusCode(message: string): string | undefined {
  return message.match(/\b(?:4\d\d|5\d\d)\b/)?.[0]
}

export function claudeTransientRetryStatus(
  message: Record<string, unknown>,
  observedAt: number
): AgentJournalStatusItem | null {
  const frame = retryFrame(message)
  if (!frame) {
    return null
  }
  const failureCategory = category(frame.errorStatus, frame.error)
  if (!failureCategory) {
    return null
  }
  const nextRetryAt = observedAt + (nonnegativeInteger(message.retry_delay_ms) ?? 0)
  const code = frame.errorStatus === null ? undefined : String(frame.errorStatus)
  return {
    kind: 'status',
    presentation: 'provider-transient-failure',
    tone: 'warning',
    text: `${frame.error}${code ? ` (code ${code})` : ''}\nRetry ${frame.attempt}/${frame.maxRetries} scheduled for ${new Date(nextRetryAt).toISOString()}.`,
    providerTransientFailure: {
      category: failureCategory,
      ...(code ? { code } : {}),
      message: frame.error,
      retry: {
        state: 'active',
        attempt: frame.attempt,
        maxRetries: frame.maxRetries,
        nextRetryAt
      },
      recovery: { state: 'provider-retrying' }
    }
  }
}

export function claudeTransientExhaustedStatus(
  message: string,
  lastRetry?: RetryFrame | null
): AgentJournalStatusItem | null {
  const boundedMessage = boundInlineText(message, DEFAULT_JOURNAL_PAYLOAD_LIMITS).text
  const code =
    lastRetry?.errorStatus == null ? statusCode(boundedMessage) : String(lastRetry.errorStatus)
  const failureCategory = category(code ? Number(code) : null, boundedMessage)
  if (!failureCategory) {
    return null
  }
  return {
    kind: 'status',
    presentation: 'provider-transient-failure',
    tone: 'error',
    text: `${boundedMessage}${code && !boundedMessage.includes(code) ? ` (code ${code})` : ''}\nProvider retry is exhausted. Pending work needs a fallback, successor, or handoff.`,
    providerTransientFailure: {
      category: failureCategory,
      ...(code ? { code } : {}),
      message: boundedMessage,
      retry: {
        state: 'exhausted',
        ...(lastRetry ? { attempt: lastRetry.attempt, maxRetries: lastRetry.maxRetries } : {})
      },
      recovery: {
        state: 'successor-required',
        detail: 'Pending work needs a fallback, successor, or handoff.'
      }
    }
  }
}

export function createClaudeTransientFailureJournal(
  sink: StructuredAgentSessionEventSink,
  acquisitionId: string
): {
  observeRetry: (message: Record<string, unknown>, observedAt: number) => boolean
  appendExhausted: (message: string) => boolean
} {
  let sequence = 0
  let lastRetry: RetryFrame | null = null
  const append = (body: AgentJournalStatusItem): void => {
    sequence += 1
    const identity: AgentJournalItemIdentity = {
      provider: 'orca',
      clientMessageId: `provider-transient:claude:${acquisitionId}:${sequence}`
    }
    sink.appendItem(identity, body)
    sink.publish()
  }
  return {
    observeRetry: (message, observedAt) => {
      const body = claudeTransientRetryStatus(message, observedAt)
      if (!body) {
        return false
      }
      lastRetry = retryFrame(message)
      append(body)
      return true
    },
    appendExhausted: (message) => {
      const body = claudeTransientExhaustedStatus(message, lastRetry)
      if (!body) {
        return false
      }
      append(body)
      lastRetry = null
      return true
    }
  }
}
