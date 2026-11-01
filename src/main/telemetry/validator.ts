// Use shared event schemas as the runtime contract for untrusted IPC and main callers. Fail closed on unknown names, extra/missing keys, wrong enums/types and overlong strings; cap warnings per name/minute to prevent stderr flooding.

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
const WARN_CACHE_MAX_ENTRIES = 256
const lastWarnAt = new Map<string, number>()

function pruneWarnCache(now: number): void {
  for (const [key, at] of lastWarnAt) {
    if (now - at >= WARN_WINDOW_MS) {
      lastWarnAt.delete(key)
    }
  }
  while (lastWarnAt.size > WARN_CACHE_MAX_ENTRIES) {
    const oldest = lastWarnAt.keys().next()
    if (oldest.done) {
      break
    }
    lastWarnAt.delete(oldest.value)
  }
}

function warnRateLimited(key: string, message: string): void {
  const now = Date.now()
  pruneWarnCache(now)
  const prev = lastWarnAt.get(key)
  if (prev !== undefined && now - prev < WARN_WINDOW_MS) {
    return
  }
  // Bound warning keys because untrusted callers can supply endless unique invalid event names.
  lastWarnAt.delete(key)
  lastWarnAt.set(key, now)
  pruneWarnCache(now)
  console.warn(`[telemetry] ${message}`)
}

export function validate<N extends EventName>(name: N, props: unknown): ValidationResult<N> {
  // Reject unknown runtime names even when callers bypass static types.
  const schema = eventSchemas[name] as (typeof eventSchemas)[EventName] | undefined
  if (!schema) {
    const reason = `unknown event: ${String(name)}`
    warnRateLimited(`unknown:${String(name)}`, reason)
    return { ok: false, reason }
  }

  // Schema enforces exact keys, types, enums and string lengths together.
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

export function _resetValidatorWarnCacheForTests(): void {
  lastWarnAt.clear()
}

export function _getValidatorWarnCacheSizeForTests(): number {
  return lastWarnAt.size
}

// Keep outgoing common-property revalidation behind the same validator surface.
export { commonPropsSchema }
