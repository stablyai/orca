// AsyncLocalStorage propagates span parents across awaits; redact completed records before sink writes.

import { AsyncLocalStorage } from 'node:async_hooks'
import { randomBytes } from 'node:crypto'
import { redactSpan, type RedactableSpan, type SpanEvent, type SpanExit } from './redactor'

export type TracerSink = {
  push(record: unknown): void
  flush(): void
  close(): void
}

export type SpanContext = {
  readonly traceId: string
  readonly spanId: string
}

export type ActiveSpan = SpanContext & {
  /** Attribute values are redacted on serialization. */
  setAttribute(key: string, value: unknown): void
  /** Event attributes use the span-attribute redaction rules. */
  addEvent(name: string, attributes?: Record<string, unknown>): void
  fail(cause: string | Error): void
  interrupt(cause?: string): void
  /** End successfully; repeated end/fail/interrupt calls have no effect. */
  end(): void
}

type PendingSpan = {
  readonly name: string
  readonly traceId: string
  readonly spanId: string
  readonly parentSpanId: string | undefined
  readonly kind: string
  readonly startTimeUnixNano: bigint
  readonly attributes: Map<string, unknown>
  readonly events: SpanEvent[]
  exit: SpanExit | null
  ended: boolean
}

const noopSpan: ActiveSpan = {
  traceId: '',
  spanId: '',
  setAttribute() {},
  addEvent() {},
  fail() {},
  interrupt() {},
  end() {}
}

let activeSink: TracerSink | null = null
const contextStorage = new AsyncLocalStorage<SpanContext>()

function genTraceId(): string {
  return randomBytes(16).toString('hex')
}
function genSpanId(): string {
  return randomBytes(8).toString('hex')
}

function nowUnixNano(): bigint {
  // Convert epoch milliseconds to the NDJSON nanosecond representation without claiming higher precision.
  return BigInt(Date.now()) * 1_000_000n
}

export function setActiveSink(sink: TracerSink | null): void {
  activeSink = sink
}

export function hasActiveTraceSink(): boolean {
  return activeSink !== null
}

/** Flush at crash boundaries that may not survive the normal batch window. */
export function flushActiveSink(): void {
  try {
    activeSink?.flush()
  } catch {
    // Optional diagnostics must not turn a recoverable crash into a main-process crash.
  }
}

export function getActiveSpanContext(): SpanContext | undefined {
  return contextStorage.getStore()
}

type SpanRecordDecision = (record: RedactableSpan) => boolean

export async function withSpan<T>(
  name: string,
  fn: (span: ActiveSpan) => Promise<T> | T,
  options?: {
    kind?: string
    attributes?: Record<string, unknown>
    shouldRecord?: SpanRecordDecision
  }
): Promise<T> {
  const span = startSpan(name, options)
  try {
    const result = await contextStorage.run({ traceId: span.traceId, spanId: span.spanId }, () =>
      fn(span)
    )
    span.end()
    return result
  } catch (err) {
    span.fail(err as Error)
    throw err
  }
}

/** Start without binding context; callers must end, fail or interrupt the span themselves. */
export function startSpan(
  name: string,
  options?: {
    kind?: string
    attributes?: Record<string, unknown>
    shouldRecord?: SpanRecordDecision
  }
): ActiveSpan {
  if (!activeSink) {
    return noopSpan
  }
  const parent = contextStorage.getStore()
  const traceId = parent?.traceId ?? genTraceId()
  const spanId = genSpanId()
  const startTimeUnixNano = nowUnixNano()

  const pending: PendingSpan = {
    name,
    traceId,
    spanId,
    parentSpanId: parent?.spanId,
    kind: options?.kind ?? 'internal',
    startTimeUnixNano,
    attributes: new Map(Object.entries(options?.attributes ?? {})),
    events: [],
    exit: null,
    ended: false
  }

  const finalize = (exit: SpanExit): void => {
    if (pending.ended) {
      return
    }
    pending.ended = true
    pending.exit = exit
    const endTimeUnixNano = nowUnixNano()
    const durationMs = Number(endTimeUnixNano - pending.startTimeUnixNano) / 1_000_000

    const record: RedactableSpan = {
      name: pending.name,
      traceId: pending.traceId,
      spanId: pending.spanId,
      ...(pending.parentSpanId ? { parentSpanId: pending.parentSpanId } : {}),
      kind: pending.kind,
      startTimeUnixNano: String(pending.startTimeUnixNano),
      endTimeUnixNano: String(endTimeUnixNano),
      durationMs,
      attributes: Object.fromEntries(pending.attributes),
      events: pending.events,
      exit
    }

    if (options?.shouldRecord && !options.shouldRecord(record)) {
      return
    }

    const redacted = redactSpan(record, 'client')
    // Keep the Effect-compatible envelope expected by existing NDJSON consumers.
    try {
      activeSink?.push({ type: 'effect-span', ...redacted })
    } catch {
      // Optional tracing failures must not fail the instrumented operation.
    }
  }

  return {
    traceId,
    spanId,
    setAttribute(key: string, value: unknown) {
      pending.attributes.set(key, value)
    },
    addEvent(eventName: string, attributes?: Record<string, unknown>) {
      pending.events.push({
        name: eventName,
        timeUnixNano: String(nowUnixNano()),
        attributes: attributes ?? {}
      })
    },
    fail(cause: string | Error) {
      const causeStr = cause instanceof Error ? formatError(cause) : String(cause)
      finalize({ _tag: 'Failure', cause: causeStr })
    },
    interrupt(cause?: string) {
      finalize({ _tag: 'Interrupted', ...(cause ? { cause } : {}) })
    },
    end() {
      finalize({ _tag: 'Success' })
    }
  }
}

function formatError(err: Error): string {
  const head = `${err.name}: ${err.message}`
  return err.stack ? `${head}\n${err.stack}` : head
}

export function _resetTracerForTests(): void {
  activeSink = null
  // Context tests should create their own withSpan scope.
}
