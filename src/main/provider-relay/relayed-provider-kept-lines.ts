/** Lines the daemon kept for an attach (session state long since acked), by the seq they were
 *  spooled at. Only an attach whose output is held for its consumer reads them; once read, a later
 *  attach's (after a dropped stream) are not held again. */
export class RelayedProviderKeptLines {
  readonly lines = new Map<number, string>()
  private read = false

  /** Whether an attach should take them: not yet read, and its output is held. */
  wanted(holding: boolean): boolean {
    return !this.read && holding
  }

  /** Keeps `line` if wanted; true when kept. */
  take(holding: boolean, seq: number, line: string): boolean {
    if (this.wanted(holding)) {
      this.lines.set(seq, line)
      return true
    }
    return false
  }

  drop(): void {
    this.read = true
    this.lines.clear()
  }
}

/** The longest the app's hand-offs (a quit's, all chats at once) wait in all for paused readers;
 *  lines one hasn't taken by then stay unacked and replay at the next launch. */
const HAND_OFF_READER_WAIT_MS = 2_000
let handOffDeadline: number | null = null

export const relayHandOffWaitMs = (): number =>
  Math.max(0, (handOffDeadline ??= Date.now() + HAND_OFF_READER_WAIT_MS) - Date.now())
