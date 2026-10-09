// The handful of facts Orca reads out of Codex app-server payloads. Codex has
// moved these fields between the envelope and a nested `thread` / `turn` object
// across releases, so each reader accepts both shapes rather than pinning one.

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** `thread/start`, `thread/resume`, and `thread/started` all name the thread. */
export function readCodexThreadId(payload: unknown): string | null {
  const root = record(payload)
  if (!root) {
    return null
  }
  return nonEmptyString(record(root.thread)?.id) ?? nonEmptyString(root.threadId)
}

/** `turn/start` responses carry `turn.id`; `turn/started` notifications carry
 *  the same under `turn`, and older builds put `turnId` on the envelope. */
export function readCodexTurnId(payload: unknown): string | null {
  const root = record(payload)
  if (!root) {
    return null
  }
  return nonEmptyString(record(root.turn)?.id) ?? nonEmptyString(root.turnId)
}

/** `turn/completed` carries `turn.status`; thread history puts `status` on the turn record itself. */
export function readCodexTurnStatus(payload: unknown): string | null {
  const root = record(payload)
  if (!root) {
    return null
  }
  return nonEmptyString(record(root.turn)?.status) ?? nonEmptyString(root.status)
}

/** A failed `turn/completed` carries Codex's reason as `turn.error.message`. */
export function readCodexTurnErrorMessage(payload: unknown): string | null {
  return nonEmptyString(record(record(record(payload)?.turn)?.error)?.message)
}

/** Codex's own turn duration, already in milliseconds; absent or malformed reads as null. */
export function readCodexTurnDurationMs(payload: unknown): number | null {
  const root = record(payload)
  if (!root) {
    return null
  }
  const value = record(root.turn)?.durationMs ?? root.durationMs
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/** `error` carries `willRetry`: Codex sets it on a stream error it is about to
 *  retry, and omits it (false) on one that ended the turn the frame names. */
export function readCodexErrorWillRetry(payload: unknown): boolean {
  return record(payload)?.willRetry === true
}

/** `error.message` on an `error` frame: Codex's own words for the person reading the chat. */
export function readCodexErrorMessage(payload: unknown): string | null {
  return nonEmptyString(record(record(payload)?.error)?.message)
}

/** `error.additionalDetails`: what failed underneath, which Codex shows under its message. */
export function readCodexErrorAdditionalDetails(payload: unknown): string | null {
  return nonEmptyString(record(record(payload)?.error)?.additionalDetails)
}

/** `error.codexErrorInfo` is a bare variant (`"serverOverloaded"`) or one keyed to its fields
 *  (`{"responseStreamDisconnected":{"httpStatusCode":502}}`); read as the variant and its status. */
export function readCodexErrorInfo(payload: unknown): { error: string; status?: unknown } | null {
  const info = record(record(payload)?.error)?.codexErrorInfo
  const bare = nonEmptyString(info)
  if (bare) {
    return { error: bare }
  }
  const [variant, fields] = Object.entries(record(info) ?? {})[0] ?? []
  return variant ? { error: variant, status: record(fields)?.httpStatusCode } : null
}

/** `thread/status/changed` carries a TAGGED status (`{status:{type}}`), never a
 *  bare string. `idle` and `systemError` are the two arms that mean the thread
 *  is not running; `active` and `notLoaded` are not. */
export function codexThreadStoppedRunning(payload: unknown): boolean {
  const type = record(record(payload)?.status)?.type
  return type === 'idle' || type === 'systemError'
}

/** An `active` thread flags each request it has open on the user (an approval, a question). */
export function codexThreadWaitsOnUser(payload: unknown): boolean {
  const status = record(record(payload)?.status)
  const flags = status?.type === 'active' ? status.activeFlags : null
  return (
    Array.isArray(flags) &&
    flags.some((flag) => flag === 'waitingOnApproval' || flag === 'waitingOnUserInput')
  )
}
