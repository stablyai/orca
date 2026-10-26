import type { IPtyProvider } from '../providers/pty-provider-contract'
import type { OwnerInventory } from './daemon-session-owner-inventory'

export async function probeDaemonSessionOwner<T extends IPtyProvider>(opts: {
  sessionId: string
  providers: readonly T[]
  routes: ReadonlyMap<string, IPtyProvider>
  removeRoute: (id: string) => void
  inventory: () => Promise<OwnerInventory<T>>
  currentEpoch: () => number
}): Promise<boolean | null> {
  const { sessionId, providers, routes } = opts
  const routed = providers.find((provider) => provider === routes.get(sessionId))
  const direct = routed ?? (providers.length === 1 ? providers[0] : undefined)
  if (direct) {
    const verdict = direct.probePtyLiveness
      ? await direct.probePtyLiveness(sessionId)
      : (direct.hasPty?.(sessionId) ?? null)
    if (verdict !== false || providers.length === 1) {
      return verdict
    }
    if (routes.get(sessionId) === routed) {
      opts.removeRoute(sessionId)
    }
  }
  const inventory = await opts.inventory()
  if (inventory.epoch !== opts.currentEpoch()) {
    return null
  }
  if ((inventory.candidatesBySessionId.get(sessionId)?.length ?? 0) > 0) {
    return true
  }
  return inventory.complete && providers.length > 0 ? false : null
}
