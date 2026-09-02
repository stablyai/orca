import type { MobileConnectionPath } from '../transport/stable-logical-rpc-client'

export type HomeHostConnectionProjectionEntry = {
  hostId: string
  path: MobileConnectionPath
  pendingPath: MobileConnectionPath | null
  pairingRejected: boolean
}

export type HomeHostConnectionProjection = {
  hostPaths: Record<string, MobileConnectionPath>
  hostPendingPaths: Record<string, MobileConnectionPath | null>
  hostPairingRejected: Record<string, boolean>
}

/** Build all host lookup maps while reading each connection entry once. */
export function projectHomeHostConnections(
  entries: readonly HomeHostConnectionProjectionEntry[]
): HomeHostConnectionProjection {
  // Null-prototype records avoid the __proto__ setter; restore the usual prototype for parity
  // with Object.fromEntries once the projection is complete.
  const hostPaths = Object.create(null) as Record<string, MobileConnectionPath>
  const hostPendingPaths = Object.create(null) as Record<string, MobileConnectionPath | null>
  const hostPairingRejected = Object.create(null) as Record<string, boolean>

  for (const { hostId, path, pendingPath, pairingRejected } of entries) {
    hostPaths[hostId] = path
    hostPendingPaths[hostId] = pendingPath
    hostPairingRejected[hostId] = pairingRejected
  }

  Object.setPrototypeOf(hostPaths, Object.prototype)
  Object.setPrototypeOf(hostPendingPaths, Object.prototype)
  Object.setPrototypeOf(hostPairingRejected, Object.prototype)

  return { hostPaths, hostPendingPaths, hostPairingRejected }
}
