// Where the structured chat host and its runtime report a failure they carry on past.
//
// One required dependency rather than a callback per failure: a host built without it does not
// compile, so no failure path can quietly drop what went wrong. The default writes each entry to
// the host's local trace file (the desktop's `<userData>/logs/main.trace.ndjson`, collected by the
// diagnostic bundle; orcad's `<data-root>/logs/orcad.trace.ndjson`) and to the console.

import { isAgentSessionRefusalError } from '../../../shared/agent-session-wire-refusals'
import { startSpan } from '../../observability/tracer'
import { createStructuredAgentSessionLogRepeats } from './structured-agent-session-log-repeats'

export type StructuredAgentSessionLogFields = {
  /** The step that failed; a stable name a log search can find. */
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

/** Reporting is bookkeeping: a logger that throws must never fail the operation it reports. */
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

/** A copy of `deps` whose logger cannot throw; every collaborator built from it inherits that. */
export function withNeverThrowingLogger<T extends { logger: StructuredAgentSessionLogger }>(
  deps: T
): T {
  return { ...deps, logger: neverThrowingStructuredAgentSessionLogger(deps.logger) }
}

/** The logger `resolve` returns at each call, for a collaborator built before the host's deps. */
export function deferredStructuredAgentSessionLogger(
  resolve: () => StructuredAgentSessionLogger
): StructuredAgentSessionLogger {
  return {
    warn: (message, fields) => resolve().warn(message, fields),
    error: (message, fields) => resolve().error(message, fields)
  }
}

/** The production logger: a failed span in the local trace file, plus the console. A repeat of
 *  the same entry is written at most once per window, carrying how many were swallowed. */
export function createStructuredAgentSessionLogger(options?: {
  now?: () => number
}): StructuredAgentSessionLogger {
  const repeats = createStructuredAgentSessionLogRepeats({ now: options?.now })
  const write =
    (level: LogLevel) =>
    (message: string, fields: StructuredAgentSessionLogFields): void => {
      const { scope, error, ...rest } = fields
      const attributes = { level, message, ...rest, ...errorAttributes(error) }
      // Keyed on all the entry writes but its stack: only a failure writing the same entry repeats.
      const suppressed = repeats.admit(
        stableJson([
          scope,
          attributes,
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

/** The span's failure carries an Error's name, message and stack; its code and causes ride here.
 *  A value that is not an Error is written whole, as it would serialize. */
function errorAttributes(error: unknown): Record<string, unknown> {
  if (error === undefined) {
    return {}
  }
  if (!(error instanceof Error)) {
    return { error }
  }
  const causes: string[] = []
  let cause: unknown = error.cause
  // Name and message only: a cause's own fields can carry what the failing step was handling.
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
  // node:sqlite's `code` is one generic value; `errcode` tells SQLITE_BUSY from SQLITE_FULL.
  const sqliteCode = codeValue('errcode' in error ? error.errcode : undefined)
  // A refusal's message is its bare code; its reason is wire-safe and tells refusals apart.
  const details = isAgentSessionRefusalError(error) ? error.refusal.details : undefined
  const reason = details && 'reason' in details ? details.reason : undefined
  return {
    ...(code !== undefined ? { errorCode: code } : {}),
    ...(sqliteCode !== undefined ? { errorErrcode: sqliteCode } : {}),
    ...(typeof reason === 'string' ? { refusalReason: reason } : {}),
    ...(causes.length > 0 ? { errorCause: causes } : {})
  }
}

/** The same value always renders the same: object keys sorted, and no throw on a cycle. */
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
