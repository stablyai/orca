import { withTimeout } from '../../../shared/promise-timeout-fallback'
import type {
  CoordinatedRelayBroker,
  LiveBrokerWaitResult
} from './relay-auth-coordinator-contract'
import type { RelayOfflineReason } from './relay-offline-reason'

// Why 20s: bounds only how long a waiter sits through armed retries and superseded opens, never
// the open it arrived on. It spans the first few rungs of the backoff ladder, so a sustained
// outage fails the caller with its cause instead of parking the demand ref.
//
// It does NOT bound the call, and an earlier version of this comment claimed it "stays inside the
// phone's 30s request budget". It cannot: the deadline is consulted only after the await below,
// and a reconcile's own ceiling is `readContext`'s cloud-refresh timeout (60s, plus one retry for
// a definitive 5xx) followed by the broker open. Measured: with a reconcile in flight, a wait at
// this default budget had not settled at 45s. `pairing.provisionRelay` reaches here through
// `requireActiveBroker`, so the phone gives up and retries while the desktop still holds a
// transient demand ref for the call it abandoned. relay-auth-coordinator-wait-budget.test.ts pins
// that so the claim cannot drift back.
export const LIVE_BROKER_WAIT_BUDGET_MS = 20_000

// Every member is a function because the wait re-reads all of it after each
// await; a snapshot would answer for a coordinator state that is already gone.
export type LiveBrokerWaitSource = {
  stopped: () => boolean
  liveBroker: () => CoordinatedRelayBroker | null
  reconcile: () => Promise<void>
  // Resolves when a fresh reconcile or a fence turns the authority over, so a
  // waiter is not left parked on a reconcile whose result is already discarded.
  authorityChange: () => Promise<void>
  armedRetry: () => Promise<void> | null
  offlineReason: () => RelayOfflineReason | null
}

export async function runLiveBrokerWait(
  source: LiveBrokerWaitSource,
  budgetMs: number
): Promise<LiveBrokerWaitResult> {
  const deadline = Date.now() + budgetMs
  let joinedReconcile = false
  while (!source.stopped()) {
    const broker = source.liveBroker()
    if (broker) {
      return { broker }
    }
    // Why the budget applies only once a reconcile has been joined: the one open
    // the waiter arrived on is never cut short, but a chain of superseding opens
    // must not outlive the budget the caller asked for.
    if (joinedReconcile && Date.now() >= deadline) {
      return settledResult(source)
    }
    const pending = source.reconcile()
    const superseded = source.authorityChange()
    joinedReconcile = true
    // Why unbounded on `pending`: a reconcile always settles — BOTH its awaits carry a deadline,
    // the broker open and `readContext`'s cloud refresh (the larger of the two, and the one an
    // earlier parenthetical here left out) — and cutting a slow-but-succeeding open short would
    // fail a pairing that was about to work. "Settles" is not "settles soon": see the ceiling
    // noted on LIVE_BROKER_WAIT_BUDGET_MS.
    await Promise.race([pending, superseded])
    if (pending !== source.reconcile()) {
      continue
    }
    // Why: a reconcile that failed transiently has already armed its own retry;
    // returning now would surface a hiccup fixed moments later. A terminal
    // outcome (signed out, unentitled, rejected) arms nothing, so its cause
    // returns without waiting.
    const armed = source.armedRetry()
    if (!armed || Date.now() >= deadline) {
      return settledResult(source)
    }
    await withTimeout(armed, deadline - Date.now(), undefined)
  }
  return settledResult(source)
}

function settledResult(source: LiveBrokerWaitSource): LiveBrokerWaitResult {
  const broker = source.liveBroker()
  return broker ? { broker } : { broker: null, offlineReason: source.offlineReason() }
}
