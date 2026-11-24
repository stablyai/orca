import { federationRelayRetryDelayMs } from '../relay/federation-relay-scheduler'

// The server's cap on one pull's held-back list.
const MAX_HELD_BACK = 50

/** Conversations on one server whose next item this Orca could not read. Each waits out its own
 *  backoff, held back from the server's pulls meanwhile, so the rest of its mail keeps its cadence. */
export class HeldPeerConversations {
  private readonly held = new Map<string, { failures: number; retryAt: number }>()

  /** What the next pull holds back, and how long it may wait before a held one is due again. Past
   *  the cap, the soonest due go unnamed: the server returns them, and they are retried first. */
  forPull(now: number, maxWaitMs: number): { holdBack: string[]; waitMs: number } {
    const waiting = [...this.held].filter(([, hold]) => hold.retryAt > now)
    waiting.sort(([, a], [, b]) => b.retryAt - a.retryAt)
    return {
      holdBack: waiting.slice(0, MAX_HELD_BACK).map(([conversationId]) => conversationId),
      waitMs: this.msUntilDue(
        waiting.map(([conversationId]) => conversationId),
        now,
        maxWaitMs
      )
    }
  }

  /** Until the first of these is due again, at most `maxMs`. */
  msUntilDue(conversationIds: Iterable<string>, now: number, maxMs: number): number {
    let ms = maxMs
    for (const conversationId of conversationIds) {
      const retryAt = this.held.get(conversationId)?.retryAt
      if (retryAt !== undefined) {
        ms = Math.min(ms, Math.max(0, retryAt - now))
      }
    }
    return ms
  }

  untilFirstDue(conversationIds: Iterable<string>, now: number, maxMs: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, this.msUntilDue(conversationIds, now, maxMs)).unref?.()
    })
  }

  isWaiting(conversationId: string, now: number): boolean {
    return (this.held.get(conversationId)?.retryAt ?? 0) > now
  }

  failed(conversationId: string, now: number): void {
    const failures = (this.held.get(conversationId)?.failures ?? 0) + 1
    this.held.set(conversationId, {
      failures,
      retryAt: now + federationRelayRetryDelayMs(failures)
    })
  }

  read(conversationId: string): void {
    this.held.delete(conversationId)
  }
}
