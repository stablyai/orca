/** An ended relay nobody collects is dropped after this, so it never holds the daemon or its spool forever. */
const ENDED_RELAY_RETENTION_MS = 24 * 60 * 60 * 1000
/** One stopped at the detached cap still holds output no app has seen: kept a week (its file is capped). */
const CAP_STOPPED_RETENTION_MS = 7 * ENDED_RELAY_RETENTION_MS

type EndedRelay = { readonly live: boolean; readonly stoppedBy: 'idle' | 'cap' | null }

/** How long each ended relay is kept for an app to collect it; attaches don't extend it. */
export class ProviderRelayEndedRetention<Relay extends EndedRelay> {
  private readonly timers = new Map<Relay, ReturnType<typeof setTimeout>>()

  constructor(private readonly expire: (relay: Relay) => void) {}

  schedule(relay: Relay): void {
    if (relay.live || this.timers.has(relay)) {
      return
    }
    const timer = setTimeout(
      () => {
        this.timers.delete(relay)
        this.expire(relay)
      },
      relay.stoppedBy === 'cap' ? CAP_STOPPED_RETENTION_MS : ENDED_RELAY_RETENTION_MS
    )
    timer.unref?.()
    this.timers.set(relay, timer)
  }

  clear(relay: Relay): void {
    clearTimeout(this.timers.get(relay))
    this.timers.delete(relay)
  }

  dispose(): void {
    this.timers.forEach((timer) => clearTimeout(timer))
    this.timers.clear()
  }
}
