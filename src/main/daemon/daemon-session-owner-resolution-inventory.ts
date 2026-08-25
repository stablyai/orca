import type { IPtyProvider, PtyProcessInfo } from '../providers/types'
import type { TerminalOwnerIdentity } from '../../shared/terminal-owner-identity'
import type { DaemonSessionOwnerResolution } from './daemon-session-owner-resolution'

export type OwnerInventory<T extends IPtyProvider> = {
  candidatesBySessionId: Map<string, { provider: T; process: PtyProcessInfo }[]>
  complete: boolean
  epoch: number
}

export function resolveDaemonSessionOwnerInventory<T extends IPtyProvider>(
  inventory: OwnerInventory<T>,
  sessionId: string,
  expectedIncarnationId: string | undefined,
  expectedIncarnationIsAuthoritative: boolean,
  expectedOwnerIdentity: TerminalOwnerIdentity | undefined,
  recordRoute: (sessionId: string, provider: T, incarnationId?: string) => void
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
  const ownerProviders = expectedOwnerIdentity
    ? new Set(
        candidates
          .filter(({ process }) => matchesOwner(process, expectedOwnerIdentity))
          .map(({ provider }) => provider)
      )
    : null
  const soleProvider = providers.size === 1 ? providers.values().next().value : undefined
  const provider =
    exactProvider &&
    (!ownerProviders || ownerProviders.has(exactProvider)) &&
    (inventory.complete || expectedIncarnationIsAuthoritative)
      ? exactProvider
      : !expectedIncarnationIsAuthoritative &&
          inventory.complete &&
          (!expectedOwnerIdentity ||
            (soleProvider !== undefined && ownerProviders?.has(soleProvider)))
        ? soleProvider
        : undefined
  if (!provider) {
    return { kind: 'unknown' }
  }
  const process = candidates.find((candidate) => candidate.provider === provider)?.process
  recordRoute(sessionId, provider, process?.incarnationId)
  return { kind: 'owner', provider }
}

function matchesOwner(process: PtyProcessInfo, expected: TerminalOwnerIdentity): boolean {
  const actual = process.ownerIdentity
  return (
    actual?.ownerIncarnationId === expected.ownerIncarnationId &&
    actual.executionHostId === expected.executionHostId &&
    actual.ownerKind === expected.ownerKind
  )
}
