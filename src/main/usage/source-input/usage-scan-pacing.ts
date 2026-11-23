// A cold scan of a large history must not saturate the disk an agent or editor is also using.
export const USAGE_SCAN_MAX_READ_BYTES_PER_SECOND = 32 * 1024 * 1024
// Below this lead, sleeping costs more wakeups than it saves disk time.
const MIN_PAUSE_MS = 50

/** Paces transcript reads to an average rate; small incremental scans never wait. */
export class UsageScanReadBudget {
  private readonly startedAt = Date.now()
  private bytes = 0

  constructor(private readonly bytesPerSecond = USAGE_SCAN_MAX_READ_BYTES_PER_SECOND) {}

  async consume(bytes: number): Promise<void> {
    if (!(bytes > 0)) {
      return
    }
    this.bytes += bytes
    const dueMs = (this.bytes / this.bytesPerSecond) * 1000 - (Date.now() - this.startedAt)
    if (dueMs >= MIN_PAUSE_MS) {
      await new Promise((resolve) => setTimeout(resolve, dueMs))
    }
  }
}

// A paced cold scan can outlast a session; saving progress lets the next launch resume instead of restart.
export const USAGE_SCAN_CHECKPOINT_INTERVAL_MS = 30_000

/** Saves the per-source records a scan would leave if it stopped now. */
export type UsageScanCheckpoint<T> = (sources: T[]) => Promise<void>

export function createUsageScanCheckpointClock(
  intervalMs = USAGE_SCAN_CHECKPOINT_INTERVAL_MS
): () => boolean {
  let last = Date.now()
  return () => {
    const now = Date.now()
    if (now - last < intervalMs) {
      return false
    }
    last = now
    return true
  }
}
