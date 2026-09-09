import type { IPtyProvider, PtyProcessInfo } from '../providers/types'
import type { RouteObservation } from './daemon-session-route-authority'
import type { DaemonSessionOwnerResolution } from './daemon-session-owner-resolution'

export type ProviderInventory<T> = { provider: T; processes: PtyProcessInfo[] | null }

export type OwnerInventory<T extends IPtyProvider> = {
  candidatesBySessionId: Map<string, { provider: T; process: PtyProcessInfo }[]>
  complete: boolean
  epoch: number
  observation: RouteObservation
}

export function indexOwnerInventory<T extends IPtyProvider>(
  entries: ProviderInventory<T>[],
  epoch: number,
  observation: RouteObservation
): OwnerInventory<T> {
  const candidatesBySessionId = new Map<string, { provider: T; process: PtyProcessInfo }[]>()
  let complete = true
  for (const entry of entries) {
    if (!entry.processes) {
      complete = false
      continue
    }
    for (const process of entry.processes) {
      const candidates = candidatesBySessionId.get(process.id) ?? []
      candidates.push({ provider: entry.provider, process })
      candidatesBySessionId.set(process.id, candidates)
    }
  }
  return { candidatesBySessionId, complete, epoch, observation }
}

export function selectInventoryOwner<T extends IPtyProvider>(
  inventory: OwnerInventory<T>,
  sessionId: string,
  providerCount: number,
  expectedIncarnationId?: string,
  expectedIncarnationIsAuthoritative = false
): DaemonSessionOwnerResolution<T> {
  const candidates = inventory.candidatesBySessionId.get(sessionId) ?? []
  const providers = new Set(candidates.map(({ provider }) => provider))
  const exactProviders = new Set(
    candidates
      .filter(({ process }) => process.incarnationId === expectedIncarnationId)
      .map(({ provider }) => provider)
  )
  const exactProvider =
    expectedIncarnationId && exactProviders.size === 1
      ? exactProviders.values().next().value
      : undefined
  const soleProvider = providers.size === 1 ? providers.values().next().value : undefined
  const provider =
    (exactProvider && (inventory.complete || expectedIncarnationIsAuthoritative)
      ? exactProvider
      : undefined) ??
    (!expectedIncarnationIsAuthoritative && inventory.complete ? soleProvider : undefined)
  if (provider) {
    return { kind: 'owner', provider }
  }
  if (inventory.complete && providers.size === 0 && providerCount > 0) {
    return { kind: 'absent' }
  }
  return { kind: 'unknown' }
}
