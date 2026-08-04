import type { IPtyProvider } from '../providers/types'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'

export async function discoverDegradedDaemonSessions(
  adapters: readonly DaemonPtyAdapter[],
  sessionProviders: Map<string, IPtyProvider>
): Promise<void> {
  for (const adapter of adapters) {
    try {
      for (const session of await adapter.listProcesses()) {
        sessionProviders.set(session.id, adapter)
      }
    } catch (error) {
      console.warn('[daemon] Failed to discover degraded daemon sessions', error)
    }
  }
}

export function listProviderSessionIds(
  sessionProviders: ReadonlyMap<string, IPtyProvider>,
  provider: IPtyProvider
): string[] {
  return [...sessionProviders]
    .filter(([, mappedProvider]) => mappedProvider === provider)
    .map(([id]) => id)
}

export function findDaemonAdapter(
  sessionProviders: ReadonlyMap<string, IPtyProvider>,
  daemonAdapters: readonly DaemonPtyAdapter[],
  sessionId: string
): DaemonPtyAdapter | null {
  const provider = sessionProviders.get(sessionId)
  return provider && daemonAdapters.includes(provider as DaemonPtyAdapter)
    ? (provider as DaemonPtyAdapter)
    : null
}
