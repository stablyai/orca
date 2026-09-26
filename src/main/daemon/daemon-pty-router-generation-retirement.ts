import { canHandoffDaemonHistory } from './daemon-history-handoff'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import type { DaemonPtyAdapterSubscriptionFanout } from './daemon-pty-adapter-subscription-fanout'
import type { DaemonSessionOwnerResolver } from './daemon-session-owner-resolution'

// Why a free-function companion and not more DaemonPtyRouter methods: this file's
// job (daemon-generation-retirement.ts's Tier-1 handoff and retireLegacyAdapter
// mutator) fits entirely behind the router's existing private members, passed in
// explicitly rather than growing the router class past its line budget.

// Why: generalizes the checkpoint-then-migrate sequence DaemonPtyRouter.shutdown()
// already runs at an explicit close (keepHistory then ackColdRestore then
// forgetRoute) so the retirement scheduler can run it proactively on an idle
// Tier-1 session. The replacement is spawned under `current` and the route is
// retargeted only once that new PTY is confirmed alive -- a failure at any step
// leaves no route recorded rather than half-migrating one, so the caller's own
// verification pass (never this function) decides whether the legacy generation
// is safe to retire.
export async function handoffIdleLegacySession(
  ownerResolver: DaemonSessionOwnerResolver<DaemonPtyAdapter>,
  current: DaemonPtyAdapter,
  adapter: DaemonPtyAdapter,
  sessionId: string
): Promise<boolean> {
  if (adapter === current || !canHandoffDaemonHistory(adapter, current)) {
    return false
  }
  try {
    await adapter.shutdown(sessionId, { keepHistory: true })
  } catch {
    return false
  }
  adapter.ackColdRestore(sessionId)
  ownerResolver.forgetRoute(sessionId, adapter)
  try {
    // Why the 80x24 fallback: doSpawn() overrides cols/rows from the checkpoint
    // this handoff just wrote (restoreInfo?.cols ?? opts.cols) whenever the cold
    // restore detects one, which it will here; the literal only covers the
    // degenerate case where detection itself comes up empty, matching the same
    // fallback already used at every other proactive-spawn call site in this tree.
    const result = await current.spawn({ sessionId, isNewSession: false, cols: 80, rows: 24 })
    if (result.exitedBeforeSpawnReply || !current.hasPty(sessionId)) {
      return false
    }
    ownerResolver.recordRoute(sessionId, current, result.incarnationId)
    return true
  } catch {
    return false
  }
}

// Why: a real invariant change -- daemon-pty-router.ts's own construction comment
// documents `legacy` as set once and never mutated. Callable only after the
// retirement scheduler's verification pass has proven the adapter owns zero
// remaining sessions (design doc section 4.3); this function itself does not
// re-check that, by design, so it stays a single unconditional mutator its
// caller gates.
export function retireLegacyAdapter(
  legacy: DaemonPtyAdapter[],
  subscriptions: DaemonPtyAdapterSubscriptionFanout,
  ownerResolver: DaemonSessionOwnerResolver<DaemonPtyAdapter>,
  adapter: DaemonPtyAdapter
): void {
  const index = legacy.indexOf(adapter)
  if (index === -1) {
    return
  }
  legacy.splice(index, 1)
  subscriptions.removeAdapter(adapter)
  // Why: without this, the owner resolver keeps polling a disposed adapter's
  // listProcesses() forever, and that permanent per-poll failure blocks
  // `complete` from ever being true again, degrading every later ownership
  // resolution on the router to 'unknown'.
  ownerResolver.removeProvider(adapter)
  adapter.dispose()
}
