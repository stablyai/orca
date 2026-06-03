// Optional OTLP/HTTP traces exporter, gated on `ORCA_OTLP_TRACES_URL`.
//
// Mode 2 in telemetry-error-tracking.md — the user (or an Orca dogfooder)
// stands up a local Grafana LGTM stack with `docker run grafana/otel-lgtm`
// and points the app at it via env vars:
//
//   ORCA_OTLP_TRACES_URL=http://localhost:4318/v1/traces
//   ORCA_OTLP_METRICS_URL=http://localhost:4318/v1/metrics    (reserved for v2)
//   ORCA_OTLP_SERVICE_NAME=orca-desktop-myname
//
// Important per the spec: "no Orca-operated OTLP endpoint." This exporter
// is only ever pointed at a user-controlled URL — the README's privacy
// section can truthfully say we do not run an OTLP ingest.
//
// Spec calls for "Effect's first-party OtlpTracer.make"; Orca does not have
// Effect in the dependency tree, so we ship a minimal OTLP/HTTP-JSON
// implementation here. The wire format is the OTLP/HTTP JSON encoding of
// the OpenTelemetry trace ProtoBuf — well-documented, accepted by Grafana
// LGTM, Tempo, Jaeger's OTLP receiver, and any compliant collector. We
// deliberately do not pull in `@opentelemetry/exporter-trace-otlp-http`
// (~80 KB of transitive deps) for a feature gated entirely on an env var
// the typical user will never set.

import { request as httpRequest, type ClientRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { URL } from 'node:url'
import { redactSpan, type RedactableSpan, type SpanEvent } from './redactor'

export type OtlpExporterOptions = {
  readonly tracesUrl: string
  readonly serviceName: string
  /** Override for the default 5-second timeout on each POST. */
  readonly timeoutMs?: number
  /** Test/diagnostic override for the in-memory span queue cap. */
  readonly maxQueueSpans?: number
}

export type OtlpExporter = {
  /** Enqueue a span for export. Best-effort; failures log a one-time warn. */
  exportSpan(span: RedactableSpan): void
  /** Force-flush any in-flight queue. Called from shutdown. */
  flush(): Promise<void>
  /** Stop the periodic timer. Called from shutdown. */
  close(): void
}

const FLUSH_INTERVAL_MS = 1_000
const MAX_BATCH = 64
const DEFAULT_MAX_QUEUE_SPANS = 1_024

type InternalSpan = {
  span: RedactableSpan
}

/**
 * Build an exporter from env vars. Returns `null` if the relevant env vars
 * are not set — callers can compose this with the consent gate by simply
 * not invoking it when consent disallows network paths.
 */
export function createOtlpExporterFromEnv(): OtlpExporter | null {
  const tracesUrl = process.env.ORCA_OTLP_TRACES_URL
  if (!tracesUrl || tracesUrl.length === 0) {
    return null
  }
  const serviceName = process.env.ORCA_OTLP_SERVICE_NAME ?? 'orca-desktop'
  return createOtlpExporter({ tracesUrl, serviceName })
}

export function createOtlpExporter(opts: OtlpExporterOptions): OtlpExporter {
  let queue: InternalSpan[] = []
  let timer: NodeJS.Timeout | null = null
  let warned = false
  let closed = false
  let flushPromise: Promise<void> | null = null
  const maxQueueSpans = Math.max(1, Math.floor(opts.maxQueueSpans ?? DEFAULT_MAX_QUEUE_SPANS))

  function ensureTimer(): void {
    if (timer || closed) {
      return
    }
    timer = setTimeout(() => {
      timer = null
      void runFlushLoop()
    }, FLUSH_INTERVAL_MS)
    if (typeof timer.unref === 'function') {
      timer.unref()
    }
  }

  async function flushBatch(): Promise<void> {
    if (queue.length === 0) {
      return
    }
    const batch = queue.splice(0, MAX_BATCH)
    const payload = encodeOtlpPayload(
      opts.serviceName,
      batch.map((b) => b.span)
    )
    try {
      await postJson(opts.tracesUrl, payload, opts.timeoutMs ?? 5_000)
    } catch (err) {
      if (!warned) {
        warned = true
        console.warn('[observability:otlp] export failed; further failures will be silent:', err)
      }
      // Drop the batch on the floor; this is a best-effort path. Re-queueing
      // forever would risk unbounded memory growth on a misconfigured URL.
    }
  }

  function runFlushLoop(): Promise<void> {
    if (flushPromise) {
      return flushPromise
    }
    // Why: MAX_BATCH flushes can be triggered by both the timer and exportSpan.
    // Serialize them so shutdown can await the currently-posting batch and a
    // slow collector cannot create overlapping POST bursts.
    flushPromise = (async () => {
      while (queue.length > 0) {
        await flushBatch()
      }
    })().finally(() => {
      flushPromise = null
    })
    return flushPromise
  }

  return {
    exportSpan(span: RedactableSpan): void {
      if (closed) {
        return
      }
      // Apply the redactor regardless of whether the caller already did —
      // idempotence makes this safe and the OTLP destination is one of the
      // three locations the spec calls for redactor application.
      const redacted = redactSpan(span, 'client')
      queue.push({ span: redacted })
      if (queue.length > maxQueueSpans) {
        // Why: a slow or misconfigured collector must not turn optional OTLP
        // export into unbounded memory growth. Keep the newest spans because
        // they are closest to the user action being diagnosed.
        queue.splice(0, queue.length - maxQueueSpans)
      }
      if (queue.length >= MAX_BATCH) {
        void runFlushLoop()
      } else {
        ensureTimer()
      }
    },
    async flush(): Promise<void> {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      await runFlushLoop()
    },
    close(): void {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      closed = true
    }
  }
}

// ── OTLP/HTTP JSON encoding ──────────────────────────────────────────────
//
// Minimal subset of the OTLP trace ProtoBuf JSON encoding — the parts an
// LGTM / Tempo / Jaeger receiver uses. Full schema: opentelemetry-proto's
// `trace/v1/trace.proto`. Anything we don't emit (status code, scope, links)
// is optional in the spec and defaults sensibly receiver-side.

type OtlpKeyValue = {
  key: string
  value:
    | { stringValue: string }
    | { intValue: string }
    | { boolValue: boolean }
    | { doubleValue: number }
}

function toOtlpAttributes(input: Record<string, unknown>): OtlpKeyValue[] {
  const out: OtlpKeyValue[] = []
  for (const [k, v] of Object.entries(input)) {
    if (v === null || v === undefined) {
      continue
    }
    if (typeof v === 'string') {
      out.push({ key: k, value: { stringValue: v } })
    } else if (typeof v === 'boolean') {
      out.push({ key: k, value: { boolValue: v } })
    } else if (typeof v === 'number') {
      // Integers fit in intValue (OTLP requires string-encoded int); floats go
      // to doubleValue. JS Number distinguishes via `Number.isInteger`.
      if (Number.isInteger(v)) {
        out.push({ key: k, value: { intValue: String(v) } })
      } else {
        out.push({ key: k, value: { doubleValue: v } })
      }
    } else {
      // Objects / arrays — flatten to a JSON string. OTLP supports an
      // array/kvlist value but the marginal cost of a structured encoder is
      // not worth it for a v1 minimal exporter. The redactor has already
      // run, so the JSON is safe to ship.
      out.push({ key: k, value: { stringValue: JSON.stringify(v) } })
    }
  }
  return out
}

function eventToOtlp(ev: SpanEvent): {
  timeUnixNano: string
  name: string
  attributes: OtlpKeyValue[]
} {
  return {
    timeUnixNano: ev.timeUnixNano,
    name: ev.name,
    attributes: toOtlpAttributes(ev.attributes as Record<string, unknown>)
  }
}

type OtlpPayload = {
  resourceSpans: {
    resource: { attributes: OtlpKeyValue[] }
    scopeSpans: {
      scope: { name: string }
      spans: {
        traceId: string
        spanId: string
        parentSpanId?: string
        name: string
        kind: number
        startTimeUnixNano: string
        endTimeUnixNano: string
        attributes: OtlpKeyValue[]
        events: ReturnType<typeof eventToOtlp>[]
        status?: { code: number; message?: string }
      }[]
    }[]
  }[]
}

function spanKindToOtlp(kind: string): number {
  // SPAN_KIND_INTERNAL=1, SERVER=2, CLIENT=3, PRODUCER=4, CONSUMER=5.
  switch (kind) {
    case 'server':
      return 2
    case 'client':
      return 3
    case 'producer':
      return 4
    case 'consumer':
      return 5
    default:
      return 1
  }
}

function encodeOtlpPayload(serviceName: string, spans: RedactableSpan[]): OtlpPayload {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [{ key: 'service.name', value: { stringValue: serviceName } }]
        },
        scopeSpans: [
          {
            scope: { name: 'orca-observability' },
            spans: spans.map((s) => {
              // STATUS_CODE: UNSET=0, OK=1, ERROR=2 — Failure → ERROR, the
              // others map to UNSET so receivers default-render as "no
              // status" rather than synthesizing OK.
              const status =
                s.exit._tag === 'Failure'
                  ? { code: 2, ...(s.exit.cause ? { message: s.exit.cause } : {}) }
                  : undefined
              return {
                traceId: s.traceId,
                spanId: s.spanId,
                ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
                name: s.name,
                kind: spanKindToOtlp(s.kind),
                startTimeUnixNano: s.startTimeUnixNano,
                endTimeUnixNano: s.endTimeUnixNano,
                attributes: toOtlpAttributes(s.attributes as Record<string, unknown>),
                events: s.events.map(eventToOtlp),
                ...(status ? { status } : {})
              }
            })
          }
        ]
      }
    ]
  }
}

function postJson(url: string, body: unknown, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    let req: ClientRequest | null = null
    const cleanupListeners = (): void => {
      req?.off('error', onError)
      req?.off('timeout', onTimeout)
    }
    const resolveOnce = (): void => {
      if (settled) {
        return
      }
      settled = true
      cleanupListeners()
      resolve()
    }
    const rejectOnce = (error: Error, options?: { destroy?: boolean }): void => {
      if (settled) {
        return
      }
      settled = true
      if (options?.destroy) {
        req?.destroy()
      }
      cleanupListeners()
      reject(error)
    }
    const onError = (error: Error): void => rejectOnce(error)
    const onTimeout = (): void => rejectOnce(new Error('OTLP timeout'), { destroy: true })
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)))
      return
    }
    const data = JSON.stringify(body)
    const protocol = parsed.protocol === 'https:' ? httpsRequest : httpRequest
    req = protocol(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'POST',
        timeout: timeoutMs,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(data)
        }
      },
      (res) => {
        // Drain so the connection can be reused / freed; the response body
        // is uninteresting for exports.
        res.resume()
        const status = res.statusCode ?? 0
        if (status >= 200 && status < 300) {
          resolveOnce()
        } else {
          rejectOnce(new Error(`OTLP HTTP ${status}`))
        }
      }
    )
    req.on('error', onError)
    req.on('timeout', onTimeout)
    req.write(data)
    req.end()
  })
}

// Test-only export so the encoder can be verified without a network round-
// trip. Not part of the runtime API.
export const _internalsForTests = {
  encodeOtlpPayload,
  toOtlpAttributes,
  spanKindToOtlp
}
