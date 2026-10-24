// Require failure reporting for errors hidden from UI; production writes local traces and console.

import { isAgentSessionRefusalError } from '../../../shared/agent-session-wire-refusals'
import { startSpan } from '../../observability/tracer'
import { createStructuredAgentSessionLogRepeats } from './structured-agent-session-log-repeats'

export type StructuredAgentSessionLogFields = {
  /** Stable failure-step name for log searches. */
  readonly scope: string
  readonly sessionId?: string
  readonly error?: unknown
  readonly [field: string]: unknown
}

export type StructuredAgentSessionLogger = {
  warn: (message: string, fields: StructuredAgentSessionLogFields) => void
  error: (message: string, fields: StructuredAgentSessionLogFields) => void
}

type LogLevel = keyof StructuredAgentSessionLogger

const guarded = new WeakSet<StructuredAgentSessionLogger>()

/** Reporting failures must never fail the reported operation. */
export function neverThrowingStructuredAgentSessionLogger(
  logger: StructuredAgentSessionLogger
): StructuredAgentSessionLogger {
  if (guarded.has(logger)) {
    return logger
  }
  const call =
    (level: LogLevel) =>
    (message: string, fields: StructuredAgentSessionLogFields): void => {
      try {
        logger[level](message, fields)
      } catch (loggerError) {
        try {
          console.warn(`[agent-session] ${message}`, { ...fields, loggerError })
        } catch {
          // Nothing is left to report to.
        }
      }
    }
  const safe: StructuredAgentSessionLogger = { warn: call('warn'), error: call('error') }
  guarded.add(safe)
  return safe
}

export function withNeverThrowingLogger<T extends { logger: StructuredAgentSessionLogger }>(
  deps: T
): T {
  return { ...deps, logger: neverThrowingStructuredAgentSessionLogger(deps.logger) }
}

/** Resolve lazily for collaborators built before host dependencies. */
export function deferredStructuredAgentSessionLogger(
  resolve: () => StructuredAgentSessionLogger
): StructuredAgentSessionLogger {
  return {
    warn: (message, fields) => resolve().warn(message, fields),
    error: (message, fields) => resolve().error(message, fields)
  }
}

/** Write trace/console at most once per repeat window, including suppressed count. */
export function createStructuredAgentSessionLogger(options?: {
  now?: () => number
}): StructuredAgentSessionLogger {
  const repeats = createStructuredAgentSessionLogRepeats({ now: options?.now })
  const write =
    (level: LogLevel) =>
    (message: string, fields: StructuredAgentSessionLogFields): void => {
      const { scope, error, ...rest } = fields
      const attributes: Record<string, unknown> = {
        level,
        message,
        ...rest,
        ...errorAttributes(error)
      }
      // Exclude stack and timing so equivalent failures share a repeat key.
      const { openMs: _openMs, ...keyed } = attributes
      const suppressed = repeats.admit(
        stableJson([
          scope,
          keyed,
          error instanceof Error ? `${error.name}: ${error.message}` : null
        ])
      )
      if (suppressed === null) {
        return
      }
      const span = startSpan(`agentSession.${scope}`, {
        attributes: suppressed > 0 ? { ...attributes, suppressed } : attributes
      })
      span.fail(error instanceof Error ? error : message)
      const print = level === 'error' ? console.error : console.warn
      print(
        `[agent-session] ${scope}: ${message}`,
        suppressed > 0 ? { ...fields, suppressed } : fields
      )
    }
  return neverThrowingStructuredAgentSessionLogger({ warn: write('warn'), error: write('error') })
}

const MAX_LOGGED_CAUSES = 3

/** Span failures carry name/message/stack; retain error codes/causes here, or whole non-Errors. */
function errorAttributes(error: unknown): Record<string, unknown> {
  if (error === undefined) {
    return {}
  }
  if (!(error instanceof Error)) {
    return { error }
  }
  const causes: string[] = []
  let cause: unknown = error.cause
  // Limit causes to name/message; custom fields may contain handled data.
  while (cause !== undefined && causes.length < MAX_LOGGED_CAUSES) {
    if (cause instanceof Error) {
      causes.push(`${cause.name}: ${cause.message}${codeSuffix(cause)}`)
      cause = cause.cause
    } else {
      causes.push(typeof cause === 'object' && cause !== null ? '[non-error cause]' : String(cause))
      cause = undefined
    }
  }
  const code = errorCode(error)
  // node:sqlite code is generic; errcode distinguishes SQLite failure kinds.
  const sqliteCode = codeValue('errcode' in error ? error.errcode : undefined)
  // Refusal messages contain only the code; wire-safe reason distinguishes them.
  const details = isAgentSessionRefusalError(error) ? error.refusal.details : undefined
  const reason = details && 'reason' in details ? details.reason : undefined
  return {
    ...(code !== undefined ? { errorCode: code } : {}),
    ...(sqliteCode !== undefined ? { errorErrcode: sqliteCode } : {}),
    ...(typeof reason === 'string' ? { refusalReason: reason } : {}),
    ...(causes.length > 0 ? { errorCause: causes } : {})
  }
}

/** Stable key order with a fallback for cycles. */
function stableJson(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, inner: unknown) => {
      if (typeof inner === 'bigint') {
        return String(inner)
      }
      if (typeof inner !== 'object' || inner === null || Array.isArray(inner)) {
        return inner
      }
      return Object.fromEntries(
        Object.entries(inner).sort(([left], [right]) => (left < right ? -1 : 1))
      )
    })
  } catch {
    return String(value)
  }
}

function errorCode(error: Error): string | number | undefined {
  return codeValue('code' in error ? error.code : undefined)
}

function codeValue(value: unknown): string | number | undefined {
  return typeof value === 'string' || typeof value === 'number' ? value : undefined
}

function codeSuffix(error: Error): string {
  const code = errorCode(error)
  return code !== undefined && !error.message.includes(String(code)) ? ` [${code}]` : ''
}
