// Accept nested and envelope fields for compatibility across Codex versions.

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function readCodexThreadId(payload: unknown): string | null {
  const root = record(payload)
  if (!root) {
    return null
  }
  return nonEmptyString(record(root.thread)?.id) ?? nonEmptyString(root.threadId)
}

export function readCodexTurnId(payload: unknown): string | null {
  const root = record(payload)
  if (!root) {
    return null
  }
  return nonEmptyString(record(root.turn)?.id) ?? nonEmptyString(root.turnId)
}

export function readCodexTurnStatus(payload: unknown): string | null {
  const root = record(payload)
  if (!root) {
    return null
  }
  return nonEmptyString(record(root.turn)?.status) ?? nonEmptyString(root.status)
}

export function readCodexTurnErrorMessage(payload: unknown): string | null {
  return nonEmptyString(record(record(record(payload)?.turn)?.error)?.message)
}

export function readCodexTurnDurationMs(payload: unknown): number | null {
  const root = record(payload)
  if (!root) {
    return null
  }
  const value = record(root.turn)?.durationMs ?? root.durationMs
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

export function readCodexErrorWillRetry(payload: unknown): boolean {
  return record(payload)?.willRetry === true
}

export function readCodexErrorMessage(payload: unknown): string | null {
  return nonEmptyString(record(record(payload)?.error)?.message)
}

export function readCodexErrorAdditionalDetails(payload: unknown): string | null {
  return nonEmptyString(record(record(payload)?.error)?.additionalDetails)
}

/** Codex versions encode error variants as either strings or single-key objects. */
export function readCodexErrorInfo(payload: unknown): { error: string; status?: unknown } | null {
  const info = record(record(payload)?.error)?.codexErrorInfo
  const bare = nonEmptyString(info)
  if (bare) {
    return { error: bare }
  }
  const [variant, fields] = Object.entries(record(info) ?? {})[0] ?? []
  return variant ? { error: variant, status: record(fields)?.httpStatusCode } : null
}

/** notLoaded does not prove a thread stopped running. */
export function codexThreadStoppedRunning(payload: unknown): boolean {
  const type = record(record(payload)?.status)?.type
  return type === 'idle' || type === 'systemError'
}

/** Only an explicit active status establishes execution ownership. */
export function codexThreadIsActive(payload: unknown): boolean {
  return record(record(payload)?.status)?.type === 'active'
}

export function codexThreadWaitsOnUser(payload: unknown): boolean {
  const status = record(record(payload)?.status)
  const flags = status?.type === 'active' ? status.activeFlags : null
  return (
    Array.isArray(flags) &&
    flags.some((flag) => flag === 'waitingOnApproval' || flag === 'waitingOnUserInput')
  )
}
