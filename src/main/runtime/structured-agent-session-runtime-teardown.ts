// Stopping an installed structured-session runtime, and the durable record of WHY it is stopping.
//
// Split out of `structured-agent-session-runtime` because installing a runtime and tearing one down
// are separate concerns that share only the handle below — and because that module had no room
// left to grow.

import type { AgentSessionResumeTrigger } from '../../shared/agent-session-resume-marker'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'

export type InstalledRuntime = {
  host: StructuredAgentSessionHost
  adapter: { closeAll(): Promise<void> }
  /** Resolves after every observed adapter exit has published, and every
   *  recovery callback it raised has settled. */
  waitForRecovery: () => Promise<void>
}

/** Why the app is going away, for the resume markers teardown stamps. A module-level latch rather
 *  than an argument because the quit path's call to `stopStructuredAgentSessionRuntime()` is
 *  asserted verbatim by the startup-ordering ratchet. */
let teardownTrigger: AgentSessionResumeTrigger = 'quit'

export function setStructuredAgentSessionTeardownTrigger(trigger: AgentSessionResumeTrigger): void {
  teardownTrigger = trigger
}

export function structuredAgentSessionTeardownTrigger(): AgentSessionResumeTrigger {
  return teardownTrigger
}

export async function tearDownRuntime(
  installed: InstalledRuntime,
  trigger: AgentSessionResumeTrigger
): Promise<void> {
  // Drain an in-flight recovery before stopping children; recovery may still
  // be writing lifecycle rows or acquiring a replacement child.
  await installed.waitForRecovery()
  const failures: unknown[] = []
  // Host teardown runs FIRST, which inverts the older order. It is what stops this host's
  // provider children now: it evicts each owned session through the adapter, and that eviction
  // only releases the lease once `disposeSession` PROVES the child gone. Closing the adapter
  // first would hand every one of those steps a vacuous receipt from an already-closed router,
  // and would race the attach drain the host runs in the same teardown.
  //
  // Tail rows are protected by eviction's own per-session ordering — stop the child, drain what
  // it already published, settle, then unbind the sink — not by which of the two teardowns runs
  // first. `closeAll` is only a backstop for children eviction never took: an acquisition that
  // failed before the host indexed it, or a session whose eviction was refused and left indexed.
  // A row a child delivers during that backstop close is not captured, and was not captured
  // under the old order either. The drain below keeps a late callback from outliving the runtime.
  try {
    await installed.host.flushAllStreamedEvents({ trigger })
  } catch (error) {
    failures.push(error)
  }
  try {
    // Backstop for children eviction never took: unindexed acquisitions and refused evictions.
    await installed.adapter.closeAll()
  } catch (error) {
    failures.push(error)
  }
  // A backstop close can still deliver a final exit callback.
  try {
    await installed.waitForRecovery()
  } catch (error) {
    failures.push(error)
  }
  if (failures.length === 1) {
    throw failures[0]
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, 'structured agent-session runtime teardown failed')
  }
}
