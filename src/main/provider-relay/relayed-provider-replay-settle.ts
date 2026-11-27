import { withTimeout } from '../../shared/concurrency/promise-timeout-fallback'
import type { RelayedProviderChild } from './relayed-provider-child'

const REPLAY_SETTLE_WAIT_MS = 3_000
const REPLAY_SETTLE_RETRY_MS = 50

/** Children whose bounded wait already ran out: later sends don't wait again (acks still land). */
const waitSpent = new WeakSet<RelayedProviderChild>()

/** Acks what a reattach replayed once the chat's reader took it, as a hand-off does, within a
 *  bound: a stalled stdin write or reader leaves the replay unacked rather than holding a send. */
export async function settleRelayedReplay(child: RelayedProviderChild): Promise<void> {
  if (waitSpent.has(child)) {
    return
  }
  // The replay reaches the reader in slices: ack each part handed on until all of it is acked.
  const until = Date.now() + REPLAY_SETTLE_WAIT_MS
  while (!child.replayAcked() && Date.now() < until) {
    const left = until - Date.now()
    await withTimeout(
      child.settle(true, left).catch(() => undefined),
      left,
      undefined
    )
    if (!child.replayAcked() && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, REPLAY_SETTLE_RETRY_MS))
    }
  }
  if (!child.replayAcked()) {
    waitSpent.add(child)
  }
}
