// Host teardown, made failure-complete.
//
// A trailing "close every journal" statement is skipped on exactly the path
// that leaks: `flushAllEventSinks` throws BY DESIGN when a sink barrier fails,
// and the attach drain can reject too. Every connection would then be left open
// with the global runtime reference already cleared — the one state from which
// nothing can ever close them.

import { agentSessionJournalCloseRetries } from '../agent-session-journal/journal-close-retry'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import { withTimeout } from '../../../shared/promise-timeout-fallback'

export type StructuredAgentSessionTeardownPhase = {
  name: string
  run: () => Promise<void> | void
}

/** Quit must not wait indefinitely on an in-flight flow; see the bounded drains below. */
const DRAIN_TIMEOUT_MS = 5_000

/** The order teardown has to happen in, kept together because the order IS the contract. */
export function structuredAgentSessionTeardownPhases({
  holds,
  runtimeState,
  handoffs,
  tasks,
  eventRecovery
}: {
  holds: { dispose: () => void }
  runtimeState: { stopLeaseRenewal: () => void; flushAllEventSinks: () => Promise<void> }
  handoffs: { stopTuiHistoryCatchup: () => void; drain: () => Promise<void> }
  tasks: { drainAttaches: () => Promise<void> }
  eventRecovery: { drainSinkRecoveries: () => Promise<void> }
}): readonly StructuredAgentSessionTeardownPhase[] {
  return [
    { name: 'dispose-holds', run: () => holds.dispose() },
    { name: 'stop-lease-renewal', run: () => runtimeState.stopLeaseRenewal() },
    { name: 'stop-tui-catchup', run: () => handoffs.stopTuiHistoryCatchup() },
    // Before the session map is dropped: a handoff flow left running writes rows into a journal
    // this teardown is about to close, and publishes against a session it removed.
    // Why bounded: this phase is on the app-quit path, and a flow wedged in `launchTui` would
    // otherwise hold the quit open forever. Giving up merely restores the old orphaning, which
    // the publish guard above already makes survivable.
    {
      name: 'drain-handoffs',
      run: () => withTimeout(handoffs.drain(), DRAIN_TIMEOUT_MS, undefined)
    },
    { name: 'drain-attaches', run: () => tasks.drainAttaches() },
    { name: 'flush-event-sinks', run: () => runtimeState.flushAllEventSinks() },
    // Ordered after the flush, because the flush is what surfaces the sink failure that starts
    // recovery. Bounded for the same reason as the handoff drain: recovery stops a provider child
    // and can re-attach one, and neither step carries a deadline of its own.
    {
      name: 'drain-sink-recoveries',
      run: () => withTimeout(eventRecovery.drainSinkRecoveries(), DRAIN_TIMEOUT_MS, undefined)
    }
  ]
}

export async function tearDownStructuredAgentSessionHost(input: {
  phases: readonly StructuredAgentSessionTeardownPhase[]
  sessions: Map<string, StructuredAgentSessionHostSession>
}): Promise<void> {
  const failures: unknown[] = []
  for (const phase of input.phases) {
    try {
      await phase.run()
    } catch (error) {
      failures.push(error)
    }
  }

  const entries = [...input.sessions.entries()]
  // `allSettled`, so one rejected close cannot skip the others.
  const closed = await Promise.allSettled(entries.map(([, session]) => session.journal.close()))
  closed.forEach((result, index) => {
    const sessionId = entries[index]?.[0]
    if (result.status === 'fulfilled') {
      // Only a FULFILLED close drops the entry. One that rejected stays indexed,
      // which is what makes a later close a real retry rather than a no-op.
      if (sessionId !== undefined) {
        input.sessions.delete(sessionId)
      }
      return
    }
    failures.push(result.reason)
  })

  // Journals an earlier failure path could not close are retried HERE, which is
  // the only place that owns them once their caller has unwound.
  failures.push(...(await agentSessionJournalCloseRetries.retryAll()))

  if (failures.length > 0) {
    throw new AggregateError(failures, 'agent session host teardown failed')
  }
}
