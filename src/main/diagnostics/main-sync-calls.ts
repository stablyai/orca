// The longest synchronous disk call since the stall probe's last tick, so a long event-loop gap can name it.
// Scalars hold references to existing strings: recording allocates nothing.
let recording = false
let longestSource = ''
let longestLabel = ''
let longestStartedAt = 0
let longestMs = -1

export type SyncCallRecord = {
  source: string
  label: string
  /** performance.now() clock. */
  startedAtMs: number
  durationMs: number
}

/** Only the main thread records; worker threads would keep a record nobody reads. */
export function recordSyncCallsOnThisThread(enabled: boolean): void {
  recording = enabled
}

/** Returns the start time for exitSyncCall; -1 when not recording. */
export function enterSyncCall(): number {
  return recording ? performance.now() : -1
}

export function exitSyncCall(startedAt: number, source: string, label: string): void {
  if (startedAt < 0) {
    return
  }
  const ms = performance.now() - startedAt
  if (ms > longestMs) {
    longestSource = source
    longestLabel = label
    longestStartedAt = startedAt
    longestMs = ms
  }
}

/** The longest call that finished since the last reset. */
export function longestSyncCall(): SyncCallRecord | null {
  return longestMs < 0
    ? null
    : {
        source: longestSource,
        label: longestLabel,
        startedAtMs: longestStartedAt,
        durationMs: longestMs
      }
}

/** Each probe tick starts a new interval; whatever blocks main next finishes after it. */
export function resetSyncCalls(): void {
  longestMs = -1
}

export function resetSyncCallsForTests(): void {
  resetSyncCalls()
  recording = false
}
