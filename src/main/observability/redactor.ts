// Apply idempotent redaction at sink write, bundle collection and server ingest.
// Server mode also strips product-telemetry identity keys.
// Envelope bounds limit size; truncating attributes would lose diagnostic stack tails.

import { redactString } from '../../shared/secret-redaction'

// Case-insensitive because HTTP header casing varies.
const CLIENT_ATTR_BLOCKLIST = new Set([
  'env',
  'environment',
  'env_vars',
  'api_key',
  'api-key',
  'apikey',
  'authorization',
  'bearer',
  'cookie',
  'password',
  'set-cookie',
  'secret',
  'token',
  'access_token',
  'refresh_token',
  'proxy-authorization',
  'headers.authorization'
])

// Strip product-telemetry identity keys so bundles cannot re-identify telemetry history.
const SERVER_ATTR_BLOCKLIST_EXTRA = new Set([
  'install_id',
  'installid',
  'distinct_id',
  'distinctid'
])

export type RedactorMode = 'client' | 'server'

function shouldDropAttributeKey(key: string, mode: RedactorMode): boolean {
  const k = key.toLowerCase()
  const normalized = k.replace(/[^a-z0-9]+/g, '')
  if (CLIENT_ATTR_BLOCKLIST.has(k)) {
    return true
  }
  // Drop secret-key families whose unlabeled values cannot be classified by string rules.
  if (
    /\b(api[-_]?key|token|secret|password|bearer|authorization|private[-_]?key)\b/i.test(key) ||
    /(apikey|token|secret|password|authorization|bearer|privkey|privatekey)/.test(normalized)
  ) {
    return true
  }
  if (mode === 'server' && SERVER_ATTR_BLOCKLIST_EXTRA.has(k)) {
    return true
  }
  return false
}

/** Recurse through containers with cycle protection for error payloads. */
export function redactValue(
  value: unknown,
  mode: RedactorMode = 'client',
  seen = new WeakSet<object>()
): unknown {
  if (value === null || value === undefined) {
    return value
  }
  if (typeof value === 'string') {
    return redactString(value)
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return value
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return '[Circular]'
    }
    seen.add(value)
    return value.map((entry) => redactValue(entry, mode, seen))
  }
  if (value instanceof Date) {
    return value
  }
  if (typeof value === 'object') {
    if (seen.has(value)) {
      return '[Circular]'
    }
    seen.add(value)
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Parsed NDJSON may contain nested auth and identity fields outside attributes.
      if (shouldDropAttributeKey(k, mode)) {
        continue
      }
      out[k] = redactValue(v, mode, seen)
    }
    return out
  }
  return `[unsupported:${typeof value}]`
}

export function redactAttributes(
  attrs: Readonly<Record<string, unknown>>,
  mode: RedactorMode = 'client'
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(attrs)) {
    if (shouldDropAttributeKey(k, mode)) {
      continue
    }
    out[k] = redactValue(v, mode)
  }
  return out
}

export type SpanEvent = {
  readonly name: string
  readonly timeUnixNano: string
  readonly attributes: Readonly<Record<string, unknown>>
}

export type SpanExit = {
  readonly _tag: 'Success' | 'Failure' | 'Interrupted'
  readonly cause?: string
}

export type RedactableSpan = {
  readonly name: string
  readonly traceId: string
  readonly spanId: string
  readonly parentSpanId?: string
  readonly kind: string
  readonly startTimeUnixNano: string
  readonly endTimeUnixNano: string
  readonly durationMs: number
  readonly attributes: Readonly<Record<string, unknown>>
  readonly events: readonly SpanEvent[]
  readonly exit: SpanExit
}

/** Return a fresh record; redact exit causes too because stacks can contain secrets. */
export function redactSpan(span: RedactableSpan, mode: RedactorMode = 'client'): RedactableSpan {
  const redactedAttrs = redactAttributes(span.attributes, mode)
  const redactedEvents: SpanEvent[] = span.events.map((ev) => ({
    name: ev.name,
    timeUnixNano: ev.timeUnixNano,
    attributes: redactAttributes(ev.attributes, mode)
  }))
  const exit: SpanExit = span.exit.cause
    ? { _tag: span.exit._tag, cause: redactString(span.exit.cause) }
    : { _tag: span.exit._tag }
  return {
    name: span.name,
    traceId: span.traceId,
    spanId: span.spanId,
    ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
    kind: span.kind,
    startTimeUnixNano: span.startTimeUnixNano,
    endTimeUnixNano: span.endTimeUnixNano,
    durationMs: span.durationMs,
    attributes: redactedAttrs,
    events: redactedEvents,
    exit
  }
}
