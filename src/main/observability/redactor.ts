// Secrets scrubber for the error-tracking lane. Runs synchronously at three
// well-defined locations (see telemetry-error-tracking.md §The redactor):
//
//   1. Sink-write time — every span is redacted before NDJSON serialization
//      and before any optional OTLP export.
//   2. Bundle-collection time — a second pass before the user-preview window
//      renders. Belt-and-suspenders against a sink-write bug.
//   3. Server-side ingest — a third pass. The client-side redactor runs on
//      an attacker-controllable binary; server-side redaction is the
//      defense-in-depth guarantee on the one path where bundle bytes reach
//      Orca infrastructure. We expose `serverSideRedact()` separately so
//      the server can additionally drop `install_id`/`installId`/
//      `distinct_id` keys (which are valid in product telemetry but must not
//      ride along on a bundle — see "Why bundles do not carry install_id").
//
// Five rule families, applied in this order:
//   1. labeled key-value (`api_key:`, `Authorization=Bearer …`)
//   2. provider-key fingerprints (8 shapes)
//   3. URL userinfo strip (`https://user:pass@host` → `https://[redacted]@host`)
//   4. .env-shape line redaction (`FOO_SECRET=…`)
//   5. attribute-key block-list (drop key entirely)
//
// Rules 1–4 operate on string values; rule 5 drops attribute *keys* before
// the values are even examined. The string passes are idempotent — running
// the redactor twice in a row produces the same output as running it once,
// which is what makes the three-location placement safe.
//
// Per-attribute length capping is deliberately NOT applied here. The spec
// argues against it (see §The redactor "No per-attribute length cap"):
// envelope-level bounds (10 MB × 10 file rotation; 10 MB Mode-3 upload cap)
// already cover the worst case, and a per-attribute truncation would eat the
// tail of long stack chains, which is the most diagnostic part. Spans that
// dump a multi-MB blob into one attribute are a call-site bug to fix at the
// call site, not at the sink.

// Word boundaries (`\b`) on the keyword alternation prevent the rule from
// firing inside compound identifiers — e.g. `FOO_SECRET=…` (an .env-shape
// line redacted by Rule 4) and `DB_PASSWORD=…` should NOT match the
// `secret`/`password` keyword here, otherwise this rule would steal the
// match from rule 4 and produce `FOO_[redacted:labeled-kv]` rather than
// preserving the key name.
//
// The value alternation `(?:Bearer\s+\S+|Token\s+\S+|\S+)` lets the rule
// consume the *whole* secret-bearing segment for the common
// `Authorization=Bearer <jwt>` / `Authorization: Token <pat>` shapes — a
// plain `\S+` would only eat `Bearer` and leave the JWT exposed.
const LABELED_KV =
  /\b(?:api[-_]?key|token|secret|password|bearer|authorization)\b\s*[:=]\s*(?:Bearer\s+\S+|Token\s+\S+|\S+)/gi

// Each provider shape replaced with a tagged token so triage can see WHAT
// was redacted (e.g. `[redacted:anthropic-key]` is a strong hint that the
// failing call was a Claude auth error) without exposing the key itself.
//
// Order: longest / most-specific patterns first. `sk-ant-…` must be tried
// before the bare `sk-…` OpenAI shape, otherwise the Anthropic key would be
// partially matched by the OpenAI rule and the `[redacted:anthropic-key]`
// triage signal would be lost.
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
    // Greedy intentionally bounded by the matching END marker; PEM blocks are
    // multi-line. The `[\s\S]+?` keeps it minimal so a buffer with two PEM
    // blocks back-to-back redacts each one independently rather than gobbling
    // text between them.
    re: /-----BEGIN [A-Z ]+-----[\s\S]+?-----END [A-Z ]+-----/g
  }
]

// Userinfo strip — preserves host + path so the debug context (`failed to
// fetch from github.com/foo/bar`) is intact while removing the credential.
// Two shapes are valid in practice and both leak credentials:
//   - `https://user:pass@host/...`  (classic basic-auth URL)
//   - `https://<token>@github.com/...` (GitHub PAT-in-URL — exactly what
//     `git clone` emits when push/pull fails. No colon, just a token before
//     the `@`.)
// The pattern matches either: any non-empty `[^/@\s]+@` after the scheme is
// userinfo and gets stripped. Spec mentions only the colon-bearing form,
// but the bare-token form is the one we actually see in failing git stderr.
const URL_USERINFO = /(https?:\/\/)([^/@\s]+)@/g

// Per-line .env shape. The `m` flag is required so `^` anchors at line
// starts inside multi-line strings (a stack frame, a captured stderr
// dump, etc.). The pattern intentionally requires the equals sign on the
// same line — `FOO=\n  bar` is a different pattern (continuation) and not
// commonly how secrets show up.
//
// The value pattern (`\S.*`) consumes to end of line so multi-token values
// like `FOO_TOKEN=Bearer <jwt>` are redacted whole rather than leaking the
// trailing token. The leading `\S` requires the value to start with a
// non-whitespace char so a bare `FOO=` followed by nothing on the same
// line doesn't get an empty redact-token.
const ENV_LINE = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*\S.*/gm

// Attribute keys that must never carry through, regardless of value. Match
// is case-insensitive — HTTP headers vary in case and we want all forms.
// `Object.hasOwn` semantics: presence in this set drops the attribute
// entirely, the value is never examined.
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

// Mode-3 server-side pass adds the PostHog-lane identity keys. These are
// valid in product telemetry but must not ride along inside a bundle —
// otherwise an Orca staff member opening the bundle could re-identify all
// PostHog history for that user (see telemetry-error-tracking.md §"Why
// bundles do not carry install_id").
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
  // Structured span attributes often carry secret labels in the key itself
  // (`ANTHROPIC_API_KEY`, `clientSecret`, `x-api-key`) with plain values that
  // string redaction cannot classify. Drop by key family before value redaction.
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

/**
 * Apply rules 1–4 to a string. Idempotent — running this twice yields the
 * same output as once, which is what makes triple-application safe.
 */
export function redactString(input: string): string {
  if (typeof input !== 'string' || input.length === 0) {
    return input
  }
  let out = input

  // Rule 1 — labeled key-value. Replace the entire `key: value` segment with
  // a tagged token. We deliberately blow away the labeled-key alongside the
  // value because the label name itself ("api_key", "Authorization") leaks
  // no useful debug context once the value is gone.
  out = out.replace(LABELED_KV, '[redacted:labeled-kv]')

  // Rule 2 — provider-key fingerprints. Each shape is tried independently,
  // so a string carrying multiple keys gets all of them redacted. The tag
  // names (e.g. `anthropic-key`) are stable wire identifiers — third-party
  // tools that read our NDJSON can grep for them.
  for (const { tag, re } of PROVIDER_PATTERNS) {
    out = out.replace(re, `[redacted:${tag}]`)
  }

  // Rule 3 — URL userinfo. Preserves scheme + host + path; replaces only the
  // `user:pass@` segment with `[redacted]@`. Done after rule 2 so a userinfo
  // value that happens to look like a provider key gets the more specific
  // redaction first.
  out = out.replace(URL_USERINFO, '$1[redacted]@')

  // Rule 4 — .env-shape line redaction. Keep the key name (`FOO_SECRET=`),
  // replace only the value with `[redacted:env-value]`. Done last among the
  // string passes so a labeled-kv match (rule 1) wins over a coincidentally
  // .env-shaped substring inside a longer line.
  out = out.replace(ENV_LINE, (_match, key) => `${String(key)}=[redacted:env-value]`)

  return out
}

/**
 * Recursively redact a value of unknown shape — strings get rules 1–4;
 * objects/arrays/maps recurse; primitives pass through. Designed for the
 * span-attribute and span-event use cases where attribute *values* can be
 * any JSON-shaped thing.
 *
 * Loop guard: we track visited references in a `WeakSet` so a self-referential
 * cycle does not stack-overflow. Cycles are unusual in span attributes but
 * span-event payloads occasionally get serialized error objects with cycles.
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
      // Why: bundle collection re-redacts parsed NDJSON, where secrets can
      // appear below attributes as nested HTTP headers or identity payloads.
      if (shouldDropAttributeKey(k, mode)) {
        continue
      }
      out[k] = redactValue(v, mode, seen)
    }
    return out
  }
  // Functions / symbols — coerce to a string label rather than carrying the
  // value through. These do not show up in legitimate spans.
  return `[unsupported:${typeof value}]`
}

/**
 * Redact an attributes record: drop blocked keys, recursively redact values
 * of remaining keys.
 */
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
 * Redact a complete span record. Returns a new record — the input is not
 * mutated, which keeps the redactor safe to run mid-pipeline (e.g. the sink
 * holds a reference to the live span until end()) and idempotent.
 *
 * The exit `cause` string carries the formatted stack trace and is one of
 * the most-likely places for a leaked secret (provider SDKs routinely echo
 * the auth token back in the error message). Apply rules 1–4 there.
 *
 * Span event attribute keys are redacted with the same blocklist as span
 * attributes; an `authorization` event-attribute is just as leaky as an
 * `authorization` span-attribute.
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

// ── Test-only introspection (kept here so tests can verify the rule set
// without re-deriving it from external assertions). ─────────────────────────

export const _internalsForTests = {
  PROVIDER_PATTERNS,
  CLIENT_ATTR_BLOCKLIST,
  SERVER_ATTR_BLOCKLIST_EXTRA,
  LABELED_KV,
  URL_USERINFO,
  ENV_LINE
}
