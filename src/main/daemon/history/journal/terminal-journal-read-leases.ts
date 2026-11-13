import { TerminalHistoryUnavailableError } from '../../protocol/daemon-history-protocol'

/**
 * Replay leases readers hold on one journal. An acquired lease's issued file reads keep the
 * journal unsettled until they really end, so no same-ID successor mutates under them. A retired
 * journal admits no new read, and a queued one that resolves after retirement lets go at once.
 */
export class TerminalJournalReadLeases {
  // At most one: the host replay semaphore has capacity 1.
  private held = 0

  constructor(
    private readonly retired: () => boolean,
    private readonly released: () => void
  ) {}

  get active(): boolean {
    return this.held > 0
  }

  async acquire(acquireReplay: () => Promise<() => void>): Promise<() => void> {
    if (this.retired()) {
      throw new TerminalHistoryUnavailableError()
    }
    const release = await acquireReplay()
    if (this.retired()) {
      release()
      throw new TerminalHistoryUnavailableError()
    }
    this.held += 1
    let open = true
    return () => {
      if (!open) {
        return
      }
      open = false
      this.held -= 1
      release()
      this.released()
    }
  }
}
