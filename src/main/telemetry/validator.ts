// Fail-closed runtime validator. Thin wrapper around
// `eventSchemas[name].safeParse(props)` — the schema defined in
// `src/shared/telemetry-events.ts` IS the validator. There is no parallel
// `EVENT_SPEC` declaration to keep in sync with `EventMap`.
//
// The validator is the single enforcement point for both main-originated
// and IPC-arrived events. TypeScript types do not survive IPC serialization,
// so the renderer cannot be trusted to send well-typed payloads — the
// renderer is explicitly in the threat model. Every shape-level promise in
// `EventMap` is also a runtime check here.
//
// Contract (all drops go through the same fail-closed path — no event is
// ever emitted when any of these fire):
//   - Unknown event name → drop + rate-limited `console.warn`.
//   - Extra property key → drop + warn. (Enforced by `.strict()` on every
//     per-event object schema — no separate check.)
//   - Missing required key → drop + warn.
//   - Wrong type / value not in declared enum → drop + warn.
//   - Any string longer than its `.max(N)` cap → drop + warn. (Enforced by
//     `.max()` in the schema; the cap and the schema are the same thing.)
//
// Warnings are rate-limited: ≤ 1 log per `event_name` per 60 s. Silent
// otherwise — a misbehaving caller should not be able to DoS stderr.

import {
  commonPropsSchema,
  eventSchemas,
  type EventName,
  type EventProps
} from '../../shared/telemetry-events'

export type ValidationResult<N extends EventName> =
  | { ok: true; props: EventProps<N> }
  | { ok: false; reason: string }

const WARN_WINDOW_MS = 60_000
const lastWarnAt = new Map<string, number>()

function warnRateLimited(key: string, message: string): void {
  const now = Date.now()
  const prev = lastWarnAt.get(key) ?? 0
  if (now - prev < WARN_WINDOW_MS) {
    return
  }
  lastWarnAt.set(key, now)
  console.warn(`[telemetry] ${message}`)
}

export function validate<N extends EventName>(name: N, props: unknown): ValidationResult<N> {
  // Event name must be a known key. `eventSchemas` is the source of truth for
  // what names exist; a cast-bypass at a call site (`track('foo' as never, {})`)
  // fails here at runtime.
  const schema = eventSchemas[name] as (typeof eventSchemas)[EventName] | undefined
  if (!schema) {
    const reason = `unknown event: ${String(name)}`
    warnRateLimited(`unknown:${String(name)}`, reason)
    return { ok: false, reason }
  }

  // `.safeParse()` is the single call that enforces exact key set (via
  // `.strict()`), types, enum membership, and per-string `.max()` caps.
  const parsed = schema.safeParse(props)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const path = issue?.path.length ? issue.path.join('.') : '<root>'
    const reason = `${String(name)}: ${path}: ${issue?.message ?? 'invalid'}`
    warnRateLimited(String(name), reason)
    return { ok: false, reason }
  }

  return { ok: true, props: parsed.data as EventProps<N> }
}

/** Test-only reset of the warn-rate-limit cache. */
export function _resetValidatorWarnCacheForTests(): void {
  lastWarnAt.clear()
}

// Re-exported so `client.ts` can re-validate the merged outgoing payload
// without reaching into `src/shared/telemetry-events.ts` directly. Keeps the
// validator as the single surface the client depends on.
export { commonPropsSchema }
