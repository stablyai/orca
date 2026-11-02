import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import type { DaemonSessionOwnerResolver } from './daemon-session-owner-resolution'

export async function reconcileDaemonRouterSessions(
  adapters: readonly DaemonPtyAdapter[],
  ownerResolver: DaemonSessionOwnerResolver<DaemonPtyAdapter>,
  validWorktreeIds: Set<string>
): Promise<{ alive: string[]; killed: string[] }> {
  const alive: string[] = []
  const killed: string[] = []
  const aliveProviders = new Map<string, Set<DaemonPtyAdapter>>()
  for (const adapter of adapters) {
    const result = await adapter.reconcileOnStartup(validWorktreeIds)
    // Avoid the argument limit when reconciling large restored-session inventories.
    for (const id of result.alive) {
      alive.push(id)
    }
    for (const id of result.killed) {
      killed.push(id)
    }
    for (const id of result.alive) {
      const providers = aliveProviders.get(id) ?? new Set<DaemonPtyAdapter>()
      providers.add(adapter)
      aliveProviders.set(id, providers)
    }
  }
  for (const id of new Set([...alive, ...killed])) {
    const providers = aliveProviders.get(id)
    if (providers?.size === 1) {
      ownerResolver.recordRoute(id, providers.values().next().value!)
    } else {
      ownerResolver.forgetRoute(id)
    }
  }
  return { alive, killed }
}
