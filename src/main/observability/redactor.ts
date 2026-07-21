// Secrets scrubber for the error-tracking lane (see telemetry-error-tracking.md
// §The redactor). Runs at three locations — sink-write, bundle-collection, and
// server-ingest; the server pass is defense-in-depth since the client runs on an
// attacker-controllable binary, and it additionally drops PostHog identity keys.
//
// The five rule families run in order; the string passes are idempotent, which
// is what makes the three-location placement safe.
//
// No per-attribute length cap: envelope bounds already cap size, and truncation
// would eat the tail of long stack chains — the most diagnostic part.

// `\b` stops this from stealing rule-4's `FOO_SECRET=` matches; the value alternation eats the whole `Bearer <jwt>`/`Token <pat>` segment.
const LABELED_KV =
  /\b(?:api[-_]?key|token|secret|password|bearer|authorization)\b\s*[:=]\s*(?:Bearer\s+\S+|Token\s+\S+|\S+)/gi

// Tagged tokens let triage see what was redacted without the key. Order is most-specific-first: `sk-ant-` before `sk-`, or the Anthropic tag is lost.
const PROVIDER_PATTERNS: { tag: string; re: RegExp }[] = [
  { tag: 'anthropic-key', re: /sk-ant-[a-zA-Z0-9_-]{40,}/g },
  { tag: 'openai-key', re: /sk-(?:proj-)?[a-zA-Z0-9_-]{32,}/g },
  { tag: 'github-token', re: /gh[pousr]_[A-Za-z0-9]{36,}/g },
  { tag: 'aws-access-key-id', re: /AKIA[0-9A-Z]{16}/g },
  {
    tag: 'aws-secret-access-key',
    re: /aws_secret_access_key\s*[:=]\s*[A-Za-z0-9/+=]{40}/gi
  },
  {
    tag: 'jwt',
    re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g
  },
  { tag: 'slack-token', re: /xox[baprsoe]-[A-Za-z0-9-]{10,}/g },
  {
    tag: 'pem',
    // Lazy `[\s\S]+?` so two back-to-back PEM blocks redact independently, not as one gobbled span.
    re: /-----BEGIN [A-Z ]+-----[\s\S]+?-----END [A-Z ]+-----/g
  }
]

// Strip URL userinfo — both `user:pass@` and bare-token `<pat>@` (seen in failing git stderr); keep host+path for debug context.
const URL_USERINFO = /(https?:\/\/)([^/@\s]+)@/g

// Per-line .env shape. `m` anchors `^` in multi-line strings; `\S.*` redacts the whole value (so `FOO=Bearer <jwt>` can't leak its tail), leading `\S` skips empty `FOO=`.
const ENV_LINE = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*\S.*/gm

// Attribute keys dropped regardless of value. Matched case-insensitively since HTTP headers vary in case.
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

// Identity keys: valid in telemetry but stripped from bundles to prevent re-identifying PostHog history (see telemetry-error-tracking.md).
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
  // Drop by key family: keys like `ANTHROPIC_API_KEY`/`x-api-key` carry plain values string redaction can't classify.
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

/** Apply rules 1–4 to a string. Idempotent, which makes triple-application safe. */
export function redactString(input: string): string {
  if (typeof input !== 'string' || input.length === 0) {
    return input
  }
  let out = input

  // Rule 1 — labeled key-value. Drop the key alongside the value; the label name adds no debug context once the value is gone.
  out = out.replace(LABELED_KV, '[redacted:labeled-kv]')

  // Rule 2 — provider-key fingerprints. Tag names (`anthropic-key`) are stable wire identifiers third-party NDJSON tools grep for.
  for (const { tag, re } of PROVIDER_PATTERNS) {
    out = out.replace(re, `[redacted:${tag}]`)
  }

  // Rule 3 — URL userinfo. After rule 2 so a key-shaped userinfo value gets the more specific redaction first.
  out = out.replace(URL_USERINFO, '$1[redacted]@')

  // Rule 4 — .env-shape line: keep key, redact value. Last so rule 1 wins over a coincidentally .env-shaped substring.
  out = out.replace(ENV_LINE, (_match, key) => `${String(key)}=[redacted:env-value]`)

  return out
}

/**
 * Recursively redact a value of unknown shape (strings get rules 1–4; containers
 * recurse; primitives pass through). The `seen` WeakSet guards against cycles,
 * which serialized error objects in span-event payloads occasionally contain.
 */
export function redactValue(
  value: unknown,
  mode: RedactorMode = 'client',
  seen: WeakSet<object> = new WeakSet()
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
      // Why: re-redacting parsed NDJSON can surface secrets nested below attributes (headers, identity payloads).
      if (shouldDropAttributeKey(k, mode)) {
        continue
      }
      out[k] = redactValue(v, mode, seen)
    }
    return out
  }
  // Functions / symbols: coerce to a label; they don't appear in legitimate spans.
  return `[unsupported:${typeof value}]`
}

/** Redact an attributes record: drop blocked keys, recursively redact the rest. */
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

// ── Span-record redaction (the public entry point used by the sink) ──────

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

/**
 * Redact a complete span record into a fresh record (input not mutated) so the
 * redactor stays safe to run mid-pipeline and idempotent. The exit `cause` holds
 * the stack trace — a likely secret-leak site — so rules 1–4 run there too.
 */
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

// Test-only introspection: lets tests verify the rule set without re-deriving it.

export const _internalsForTests = {
  PROVIDER_PATTERNS,
  CLIENT_ATTR_BLOCKLIST,
  SERVER_ATTR_BLOCKLIST_EXTRA,
  LABELED_KV,
  URL_USERINFO,
  ENV_LINE
}
