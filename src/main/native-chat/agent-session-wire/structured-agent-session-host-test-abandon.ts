// What a host that VANISHES without a clean quit has to release, for the tests that model one.
//
// Deliberately not the quit path: quit evicts provider children and releases leases, and that is
// the state a restart test is checking gets re-derived from disk. It stops short of ownership.
//
// What it cannot skip is work already in flight, which is what every copy of this helper used to
// get wrong. Two producers reach the session store after the last awaited call has returned — a
// lease-renewal tick, and the restart the delivery loop wakes for an accepted send — and the store
// re-creates its own directory before every commit. A commit landing after the test removed its
// temp directory therefore puts that directory back, and the removal fails with ENOTEMPTY. Quit
// waits for both, in its `stop-lease-renewal` and `drain-attaches` phases; so does this.

import type { StructuredAgentSessionHost } from './structured-agent-session-host'

export async function abandonStructuredAgentSessionHost(
  host: StructuredAgentSessionHost
): Promise<void> {
  // First, so the drain below cannot race the loop into enqueueing another step.
  host['conversationDelivery'].dispose()
  host['lifetime'].dispose()
  await host['runtimeState'].stopLeaseRenewal()
  await host['tasks'].drainAttaches()
  await Promise.all([...host['sessions'].values()].map((session) => session.journal.close()))
  host['sessions'].clear()
}
