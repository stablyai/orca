import type { StructuredAgentSessionHost } from './structured-agent-session-host'

// Simulate crash without releasing ownership. Stop delivery/renewals and drain in-flight writes
// before closing test databases so pending producers cannot commit after cleanup.

export async function abandonStructuredAgentSessionHost(
  host: StructuredAgentSessionHost,
  options: { cleanup?: true } = {}
): Promise<void> {
  if (options.cleanup) {
    const failures: unknown[] = []
    for (const stop of [
      () => host.stopDelivery(),
      () => host['lifetime'].dispose(),
      () => host['runtimeState'].acquireAborts.abortAll('abandoned by test cleanup')
    ]) {
      try {
        stop()
      } catch (error) {
        failures.push(error)
      }
    }
    for (const drain of [
      () => host['runtimeState'].stopLeaseRenewal(),
      () => host['tasks'].drainAttaches(),
      () => host['runtimeState'].flushAllEventSinks()
    ]) {
      try {
        await drain()
      } catch (error) {
        failures.push(error)
      }
    }
    const sessions = [...host['sessions']]
    for (const [id, session] of sessions) {
      try {
        await session.journal.close()
        host['sessions'].delete(id)
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'abandoned test host failed to drain', { cause: host })
    }
    return
  }
  // Stop admission before draining to prevent new delivery steps.
  host['conversationDelivery'].dispose()
  host['lifetime'].dispose()
  await host['runtimeState'].stopLeaseRenewal()
  await host['tasks'].drainAttaches()
  await Promise.all([...host['sessions'].values()].map((session) => session.journal.close()))
  host['sessions'].clear()
}
