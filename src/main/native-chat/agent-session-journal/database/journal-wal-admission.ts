export const JOURNAL_WAL_BACKPRESSURE_FRAMES = 32_768
/** Send-critical writes pass WAL pressure up to this hard ceiling, so their WAL growth stays bounded. */
export const JOURNAL_WAL_URGENT_FRAMES = 2 * JOURNAL_WAL_BACKPRESSURE_FRAMES

export type JournalWalState = {
  stopped: boolean
  /** A retired worker may still hold a truncate's write lock. */
  draining?: boolean
  unknown: boolean
  blocked: boolean
  truncating: boolean
  log: number
}

/** Bulk writes wait on WAL pressure; urgent ones wait only for a truncate, an unknown WAL or the ceiling. */
export function journalWalGated(state: JournalWalState, urgent: boolean): boolean {
  if (state.draining) {
    return true
  }
  if (state.stopped) {
    return false
  }
  if (state.unknown || state.truncating) {
    return true
  }
  return urgent
    ? state.log >= JOURNAL_WAL_URGENT_FRAMES
    : state.blocked || state.log >= JOURNAL_WAL_BACKPRESSURE_FRAMES
}

/** Writers parked on WAL admission, each resumed once its own class is admitted. */
export class JournalWalWaiters {
  private readonly parked = new Set<{ urgent: boolean; resume: () => void }>()

  get waiting(): boolean {
    return this.parked.size > 0
  }

  park(urgent: boolean, resume: () => void): void {
    this.parked.add({ urgent, resume })
  }

  wake(gated: (urgent: boolean) => boolean): void {
    for (const waiter of this.parked) {
      if (!gated(waiter.urgent)) {
        this.parked.delete(waiter)
        waiter.resume()
      }
    }
  }
}
