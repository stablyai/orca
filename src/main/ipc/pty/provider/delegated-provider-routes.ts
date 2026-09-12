import type { IPtyProvider } from '../../../providers/types'
import {
  parsePtyOwnershipTransferWireIdentity,
  type PtyOwnershipTransferWireIdentity
} from '../../../../shared/pty-ownership-transfer-wire'
import {
  parsePtyOwnershipTransferDestinationClaim,
  type PtyOwnershipTransferDestinationClaim
} from '../../../../shared/pty-ownership-transfer-destination-claim'
import { samePtyOwnershipTransferIdentity } from '../../../../shared/pty-ownership-transfer-identity'
import { parseAppSshPtyId } from '../../../../shared/ssh-pty-id'
import { parseRemoteRuntimePtyId } from '../../../../shared/remote-runtime-pty-id'

type Route = {
  identity: PtyOwnershipTransferWireIdentity
  claim?: PtyOwnershipTransferDestinationClaim
  provider?: IPtyProvider
  retired?: boolean
}
const routes = new Map<string, Route>()
let revision = 0
export const delegatedPtyProviderRoutesRevision = () => revision

/** Reserve before terminal registration; disconnected reservations never fall back locally. */
export function reserveDelegatedPtyProviderRoute(value: PtyOwnershipTransferWireIdentity): void {
  const identity = parsePtyOwnershipTransferWireIdentity(value)
  if (parseAppSshPtyId(identity.terminalId) || parseRemoteRuntimePtyId(identity.terminalId)) {
    throw new Error('delegated_pty_provider_requires_host_local_id')
  }
  const existing = routes.get(identity.terminalId)
  if (existing && !samePtyOwnershipTransferIdentity(existing.identity, identity)) {
    throw new Error('delegated_pty_provider_identity_conflict')
  }
  if (!existing) {
    routes.set(identity.terminalId, { identity: Object.freeze({ ...identity }) })
    revision++
  }
}

export function bindDelegatedPtyProviderRoute(
  identity: PtyOwnershipTransferWireIdentity,
  value: PtyOwnershipTransferDestinationClaim,
  provider: IPtyProvider
): () => void {
  const claim = parsePtyOwnershipTransferDestinationClaim(value)
  reserveDelegatedPtyProviderRoute(identity)
  const route = routes.get(identity.terminalId)!
  if (route.retired) {
    throw new Error('delegated_pty_provider_exited')
  }
  if (
    route.claim &&
    (claim.generation < route.claim.generation ||
      (claim.generation === route.claim.generation &&
        (claim.claimId !== route.claim.claimId || route.provider !== provider)))
  ) {
    throw new Error('delegated_pty_provider_claim_conflict')
  }
  route.claim = Object.freeze({ ...claim })
  route.provider = provider
  revision++
  return () => {
    if (
      route.claim?.generation === claim.generation &&
      route.claim.claimId === claim.claimId &&
      route.provider === provider
    ) {
      route.provider = undefined
      revision++
    }
  }
}

export function hasDelegatedPtyProviderRoute(ptyId: string): boolean {
  return routes.has(ptyId)
}

/** Call only after validating durable, output-drained retirement evidence. */
export function retireDelegatedPtyProviderRoute(
  value: PtyOwnershipTransferWireIdentity,
  claimValue: PtyOwnershipTransferDestinationClaim
): void {
  const identity = parsePtyOwnershipTransferWireIdentity(value)
  const claim = parsePtyOwnershipTransferDestinationClaim(claimValue)
  const existing = routes.get(identity.terminalId)
  if (existing && !samePtyOwnershipTransferIdentity(existing.identity, identity)) {
    throw new Error('delegated_pty_provider_identity_conflict')
  }
  if (
    existing?.claim &&
    (existing.claim.generation !== claim.generation || existing.claim.claimId !== claim.claimId)
  ) {
    throw new Error('delegated_pty_provider_claim_conflict')
  }
  reserveDelegatedPtyProviderRoute(identity)
  const route = routes.get(identity.terminalId)!
  if (route.retired) {
    return
  }
  route.retired = true
  route.claim = Object.freeze({ ...claim })
  route.provider = undefined
  revision++
}

export function snapshotDelegatedPtyProviderRoutes() {
  return [...routes.values()]
    .filter((route) => !route.retired)
    .map((route) => {
      const provider = route.provider
      const claim = route.claim
      return {
        identity: { ...route.identity },
        provider,
        isCurrent: () => !route.retired && route.provider === provider && route.claim === claim
      }
    })
}

export function getDelegatedPtyProvider(ptyId: string): IPtyProvider | undefined {
  const route = routes.get(ptyId)
  if (route?.retired) {
    throw new Error('delegated_pty_provider_exited')
  }
  if (route && !route.provider) {
    throw new Error('delegated_pty_provider_unverifiable')
  }
  return route?.provider
}
