// Simulate crash without releasing ownership. Stop delivery/renewals and drain in-flight writes
// before closing test databases so pending producers cannot commit after cleanup.

import type { StructuredAgentSessionHost } from './structured-agent-session-host'

export async function abandonStructuredAgentSessionHost(
  host: StructuredAgentSessionHost
): Promise<void> {
  // Stop admission before draining to prevent new delivery steps.
  host['conversationDelivery'].dispose()
  host['lifetime'].dispose()
  await host['runtimeState'].stopLeaseRenewal()
  await host['tasks'].drainAttaches()
  await Promise.all([...host['sessions'].values()].map((session) => session.journal.close()))
  host['sessions'].clear()
}
