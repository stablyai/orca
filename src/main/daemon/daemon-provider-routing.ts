import type { DaemonFreshSpawnAdmission } from './daemon-fresh-spawn-admission'
import { checkDaemonHealth } from './daemon-health'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import { DaemonPtyRouter } from './daemon-pty-router'

export type DaemonProvider = DaemonPtyRouter | DaemonPtyAdapter

export function getCurrentDaemonAdapter(provider: DaemonProvider): DaemonPtyAdapter {
  if (provider instanceof DaemonPtyRouter) {
    return provider.getCurrentAdapter()
  }
  return provider
}

export function getLegacyDaemonAdapters(provider: DaemonProvider): DaemonPtyAdapter[] {
  if (provider instanceof DaemonPtyRouter) {
    return [...provider.getLegacyAdapters()]
  }
  return []
}

export function disposeProviderSubscriptionsOnly(provider: DaemonProvider): void {
  if (provider instanceof DaemonPtyRouter) {
    provider.disposeRouterOnly()
  }
}

export function createDaemonProviderRouting(
  current: DaemonPtyAdapter,
  legacy: DaemonPtyAdapter[],
  freshSpawns: DaemonFreshSpawnAdmission
): DaemonProvider {
  return legacy.length > 0 || freshSpawns.unavailable
    ? new DaemonPtyRouter({ current, legacy, freshSpawnAdmission: freshSpawns })
    : current
}

export function resetDaemonFreshSpawnAdmission(
  admission: DaemonFreshSpawnAdmission,
  endpoint: { socketPath: string; tokenPath: string },
  unavailable: boolean
): void {
  admission.reset(
    unavailable
      ? async () => (await checkDaemonHealth(endpoint.socketPath, endpoint.tokenPath)) === 'healthy'
      : null
  )
}
