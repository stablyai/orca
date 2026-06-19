// A small, plain-TS span recorder modeled on a local-first
// `LocalFileTracer` / `TraceSink` pair. Orca does not use Effect, so we
// port the *behavior* — span lifecycle, attribute capture, exit-status
// recording — rather than the Effect Tracer.Tracer interface, and emit the
// same NDJSON record shape our local sink expects (`type: 'effect-span'`,
// `traceId`, `spanId`, `parentSpanId?`, `attributes`, `events`, `exit`).
// The compact shape keeps local diagnostic files readable and cheap to
// collect for user-reviewed support uploads.
//
// Concurrency model: in-process span tree maintained via Node's
// `AsyncLocalStorage`, so a child span created inside an `await` chain
// inherits its caller's parent without explicit threading. The tree itself
// is single-threaded — Electron's main process is one v8 isolate, no
// worker_threads in this layer — so plain in-memory state is enough.
//
// All spans hand off through `redactSpan()` before serialization. The
// redactor is run at sink-write time, again at bundle-collection time, and
// a third time on the server (see redactor.ts) — three locations of one
// idempotent function. The runtime cost is dominated by `redactString` on
// the exit cause string and is negligible at the span volume we expect.

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
  /** Set or overwrite an attribute on this span. Free-form values are fine
   *  — they pass through `redactValue` at serialization time. */
  setAttribute(key: string, value: unknown): void
  /** Record a span event (an embedded log message). `attributes` are
   *  redacted with the same blocklist as span attributes. */
  addEvent(name: string, attributes?: Record<string, unknown>): void
  /** Mark the span complete with a Failure exit. `cause` typically holds
   *  the formatted stack chain. */
  fail(cause: string | Error): void
  /** Mark the span complete with an Interrupted exit (user cancellation,
   *  process abort). */
  interrupt(cause?: string): void
  /** Mark the span complete with a Success exit. Idempotent — calling end()
   *  twice is a no-op so wrappers can call it from a finally block without
   *  worrying about a prior fail()/interrupt() race. */
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
  setAttribute() {
    /* no-op */
  },
  addEvent() {
    /* no-op */
  },
  fail() {
    /* no-op */
  },
  interrupt() {
    /* no-op */
  },
  end() {
    /* no-op */
  }
}

let activeSink: TracerSink | null = null
const contextStorage = new AsyncLocalStorage<SpanContext>()

// 16-byte traceId / 8-byte spanId — compact hex IDs keep local NDJSON
// records close to standard trace shapes without introducing UUID dashes.
function genTraceId(): string {
  return randomBytes(16).toString('hex')
}
function genSpanId(): string {
  return randomBytes(8).toString('hex')
}

function nowUnixNano(): bigint {
  // Date.now() is millisecond-precision; Effect's NativeSpan uses
  // process.hrtime.bigint() but the boot-time offset is annoying to align.
  // Millisecond × 1e6 is fine for the scope of "did span A start before
  // span B" comparisons within one process.
  return BigInt(Date.now()) * 1_000_000n
}

/** Install the active sink. Called by `index.ts` from the composition root.
 *  Multiple installs are not supported — `setActiveSink(null)` clears. */
export function setActiveSink(sink: TracerSink | null): void {
  activeSink = sink
}

/** Get the current parent context, or `undefined` if we are at the top of
 *  the trace tree. Renderer-IPC entry points capture this, embed it in
 *  span-event attributes (so cross-process spans can be visually linked
 *  later in v2), and start a new trace. */
export function getActiveSpanContext(): SpanContext | undefined {
  return contextStorage.getStore()
}

/**
 * Start a span and run `fn` inside its context. The returned promise
 * resolves to `fn`'s return value; `fn`'s thrown errors propagate after
 * the span has been recorded as a Failure.
 *
 * This is the function 90% of call sites should reach for: it keeps span
 * lifetime scoped to the async work it measures.
 */
export async function withSpan<T>(
  name: string,
  fn: (span: ActiveSpan) => Promise<T> | T,
  options?: { kind?: string; attributes?: Record<string, unknown> }
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

/**
 * Start a span without binding it to a context. Use when the lifecycle is
 * not naturally scoped to a function — long-running PTY sessions, agent
 * lifecycles. The caller is responsible for calling `end()` / `fail()`;
 * forgetting to end leaks memory in the pending map until the next
 * `clearPending()`.
 *
 * Hot path is `withSpan`; this is the escape hatch.
 */
export function startSpan(
  name: string,
  options?: { kind?: string; attributes?: Record<string, unknown> }
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

    const redacted = redactSpan(record, 'client')
    // Wrap in a `type: 'effect-span'` envelope so the NDJSON file is
    // compatible with Effect-style span output. Effect-oriented consumers
    // (the LGTM stack, jq cookbooks) can read the file unchanged.
    activeSink?.push({ type: 'effect-span', ...redacted })
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

/** Pretty-print an Error including stack, for the Failure cause field. The
 *  redactor handles the in-string secret stripping. */
function formatError(err: Error): string {
  const head = `${err.name}: ${err.message}`
  return err.stack ? `${head}\n${err.stack}` : head
}

// ── Test-only ────────────────────────────────────────────────────────────

export function _resetTracerForTests(): void {
  activeSink = null
  // No way to clear the AsyncLocalStorage without a fresh one; tests that
  // assert on context should run inside their own `withSpan` block.
}
