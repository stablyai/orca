import type { RelayHostReachability } from '../transport/relay-host-reachability'
import type { MobileConnectionPath } from '../transport/stable-logical-rpc-client'

export type HomeHostConnectionProjectionEntry = {
  hostId: string
  path: MobileConnectionPath
  pendingPath: MobileConnectionPath | null
  pairingRejected: boolean
  relayHostReachability: RelayHostReachability
}

export type HomeHostConnections = Record<string, HomeHostConnectionProjectionEntry>

/** One lookup carrying every connection field, so a new one costs no plumbing. */
export function projectHomeHostConnections(
  entries: readonly HomeHostConnectionProjectionEntry[]
): HomeHostConnections {
  // Why: a host named `__proto__` must land as an own key, not mutate the prototype.
  const byHostId: HomeHostConnections = Object.create(null)
  for (const entry of entries) {
    byHostId[entry.hostId] = entry
  }
  Object.setPrototypeOf(byHostId, Object.prototype)
  return byHostId
}
