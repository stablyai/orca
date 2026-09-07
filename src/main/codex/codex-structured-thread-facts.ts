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

/** Rollout file for the thread, when Codex reports one. Journal recovery reads
 *  it; a null just falls back to the existing session-file resolver. */
export function readCodexThreadPath(payload: unknown): string | null {
  const root = record(payload)
  return root ? nonEmptyString(record(root.thread)?.path) : null
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
