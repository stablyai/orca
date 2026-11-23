export const JOURNAL_WAL_BACKPRESSURE_FRAMES = 32_768
/** Send-critical writes pass WAL pressure up to this hard ceiling, so their WAL growth stays bounded. */
export const JOURNAL_WAL_URGENT_FRAMES = 2 * JOURNAL_WAL_BACKPRESSURE_FRAMES

export type JournalWalState = {
  stopped: boolean
  unknown: boolean
  log: number
  checkpointed: number
}

/** Writes wait on frames no checkpoint has copied yet; a fully copied WAL restarts on the next write. */
export function journalWalGated(state: JournalWalState, urgent: boolean): boolean {
  if (state.stopped) {
    return false
  }
  if (state.unknown) {
    return true
  }
  const backlog = state.log - state.checkpointed
  return backlog >= (urgent ? JOURNAL_WAL_URGENT_FRAMES : JOURNAL_WAL_BACKPRESSURE_FRAMES)
}

/** Writers parked on WAL admission, each resumed once its own class is admitted. */
export class JournalWalWaiters {
  private readonly parked = new Set<{ urgent: boolean; resume: () => void }>()

  get size(): number {
    return this.parked.size
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
