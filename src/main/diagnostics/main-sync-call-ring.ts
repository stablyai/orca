// Recent synchronous disk calls on this thread, so a long event-loop gap can name the call that held it.
// Preallocated slots hold references to existing strings: recording allocates nothing.
const SLOTS = 64
const sources: (string | undefined)[] = Array.from({ length: SLOTS }, () => undefined)
const labels: (string | undefined)[] = Array.from({ length: SLOTS }, () => undefined)
const startedAt = new Float64Array(SLOTS)
const endedAt = new Float64Array(SLOTS)
const sequences = new Float64Array(SLOTS)
let sequence = 0
let recording = false

export type SyncCallRecord = {
  source: string
  label: string
  /** performance.now() clock. */
  startedAtMs: number
  durationMs: number
}

/** Only the main thread records; worker threads would fill a ring nobody reads. */
export function recordSyncCallsOnThisThread(enabled: boolean): void {
  recording = enabled
}

/** Returns a token for exitSyncCall; -1 when not recording. */
export function enterSyncCall(source: string, label: string): number {
  if (!recording) {
    return -1
  }
  const token = ++sequence
  const slot = token % SLOTS
  sources[slot] = source
  labels[slot] = label
  sequences[slot] = token
  startedAt[slot] = performance.now()
  endedAt[slot] = Number.NaN
  return token
}

export function exitSyncCall(token: number): void {
  if (token < 0) {
    return
  }
  const slot = token % SLOTS
  // A nested burst may have reused the slot; its newer call owns it now.
  if (sequences[slot] === token) {
    endedAt[slot] = performance.now()
  }
}

/** The longest finished call that started at or after fromMs. */
export function longestSyncCallSince(fromMs: number): SyncCallRecord | null {
  let best = -1
  let bestMs = -1
  for (let slot = 0; slot < SLOTS; slot++) {
    const ms = endedAt[slot]! - startedAt[slot]!
    if (sequences[slot]! > 0 && startedAt[slot]! >= fromMs && ms > bestMs) {
      best = slot
      bestMs = ms
    }
  }
  if (best < 0) {
    return null
  }
  return {
    source: sources[best]!,
    label: labels[best]!,
    startedAtMs: startedAt[best]!,
    durationMs: bestMs
  }
}

export function resetSyncCallsForTests(): void {
  sequence = 0
  sequences.fill(0)
  recording = false
}
