import { federationRelayRetryDelayMs } from '../relay/federation-relay-scheduler'

// The server's cap on one pull's held-back list.
const MAX_HELD_BACK = 50

/** Conversations on one server whose next item this Orca could not read. Each waits out its own
 *  backoff, held back from the server's pulls meanwhile, so the rest of its mail keeps its cadence. */
export class HeldPeerConversations {
  private readonly held = new Map<string, { failures: number; retryAt: number }>()

  /** What the next pull holds back, and how long it may wait before a held one is due again. */
  forPull(now: number, maxWaitMs: number): { holdBack: string[]; waitMs: number } {
    const holdBack: string[] = []
    let waitMs = maxWaitMs
    for (const [conversationId, hold] of this.held) {
      if (hold.retryAt > now && holdBack.length < MAX_HELD_BACK) {
        holdBack.push(conversationId)
        waitMs = Math.min(waitMs, hold.retryAt - now)
      }
    }
    return { holdBack, waitMs }
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
