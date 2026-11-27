// The synchronous disk call that ran longest into the stall probe's next gap, so a long gap can name it.
// Scalars hold references to existing strings: recording allocates nothing.
let recording = false
let longestSource = ''
let longestLabel = ''
let longestStartedAt = 0
let longestMs = -1
let longestOverlapMs = 0
/** The next tick's due time: a call that ended before it cannot have delayed that tick. */
let countFrom = 0

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
  if (startedAt >= 0) {
    recordSyncCall(source, label, startedAt, performance.now())
  }
}

/** Ranks calls by how long they ran past the next tick's due time: only that part can delay the tick. */
export function recordSyncCall(
  source: string,
  label: string,
  startedAt: number,
  endedAt: number
): void {
  const overlapMs = endedAt - Math.max(startedAt, countFrom)
  if (overlapMs > 0 && overlapMs > longestOverlapMs) {
    longestSource = source
    longestLabel = label
    longestStartedAt = startedAt
    longestMs = endedAt - startedAt
    longestOverlapMs = overlapMs
  }
}

/** The call that ran longest past the due time given to the last reset. */
export function longestSyncCall(): SyncCallRecord | null {
  return longestOverlapMs <= 0
    ? null
    : {
        source: longestSource,
        label: longestLabel,
        startedAtMs: longestStartedAt,
        durationMs: longestMs
      }
}

/** Each probe tick passes when the next tick is due; only calls that run past it can delay that tick. */
export function resetSyncCalls(nextTickDueAtMs = 0): void {
  longestMs = -1
  longestOverlapMs = 0
  countFrom = nextTickDueAtMs
}

export function resetSyncCallsForTests(): void {
  resetSyncCalls()
  recording = false
}
