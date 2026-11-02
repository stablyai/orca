import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import type { IPtyProvider } from '../providers/pty-provider-contract'
import type { DaemonSessionOwnerResolver } from './daemon-session-owner-resolution'
import { shouldHandoffDaemonHistory } from './daemon-history-handoff'

export async function shutdownRoutedDaemonSession(
  id: string,
  options: Parameters<IPtyProvider['shutdown']>[1],
  adapter: DaemonPtyAdapter,
  current: DaemonPtyAdapter,
  routes: ReadonlyMap<string, DaemonPtyAdapter>,
  resolver: DaemonSessionOwnerResolver<DaemonPtyAdapter>
): Promise<void> {
  const migrateHistory = shouldHandoffDaemonHistory(options.keepHistory, adapter, current)
  await adapter.shutdown(id, options)
  if (!options.keepHistory || migrateHistory) {
    if (migrateHistory) {
      adapter.ackColdRestore(id)
    }
    if (routes.get(id) === adapter) {
      resolver.forgetRoute(id, adapter)
    }
  }
}

export async function shutdownRoutedDegradedSession(
  id: string,
  options: Parameters<IPtyProvider['shutdown']>[1],
  provider: IPtyProvider,
  routes: Map<string, IPtyProvider>
): Promise<void> {
  await provider.shutdown(id, options)
  if (!options.keepHistory && routes.get(id) === provider) {
    routes.delete(id)
  }
}
