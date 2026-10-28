import { DELEGATED_MOBILE_DEVICES_RUNTIME_CAPABILITY } from '../../../shared/delegated-mobile-device-contract'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { describePairedServerHosts } from '../../../shared/paired-server-hosts'
import type {
  MobileRelayHost,
  MobileRelayHostRelay
} from '../../../shared/mobile-relay-hosts-contract'
import { lastVerifiedRuntimeStatus } from '../../../shared/runtime-host-status'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import type {
  MobileDesktopRelayHostListing,
  MobileDesktopRelayHosts
} from './mobile-desktop-relay-hosts'

export type DescribedRelayHost = MobileRelayHost & {
  environmentId: string
  identity: Pick<MobileDesktopRelayHostListing, 'pairingRevision' | 'runtimeId'>
}

export function describeRelayHosts(
  hosts: Pick<MobileDesktopRelayHosts, 'list'>,
  hostLabelOverrides: ReadonlyMap<ExecutionHostId, string> = new Map()
): DescribedRelayHost[] {
  const listing = hosts.list()
  const identities = new Map(
    listing.environments.map((environment) => [environment.id, environment])
  )
  return describePairedServerHosts({ ...listing, hostLabelOverrides }).flatMap((host) => {
    const identity = identities.get(host.environmentId)
    if (!identity) {
      return []
    }
    const answer = lastVerifiedRuntimeStatus(listing.statusByEnvironmentId.get(host.environmentId))
    return [
      {
        hostId: host.hostId,
        environmentId: host.environmentId,
        identity: { pairingRevision: identity.pairingRevision, runtimeId: identity.runtimeId },
        label: host.label,
        health: host.health,
        relay: relayVerdict(host.health, answer)
      }
    ]
  })
}

export function relayHostFence(identity: DescribedRelayHost['identity']): string {
  return `${identity.pairingRevision}\0${identity.runtimeId}`
}

function relayVerdict(
  health: MobileRelayHost['health'],
  answer: RuntimeStatus | null
): MobileRelayHostRelay {
  if (!answer) {
    return 'unavailable'
  }
  // Build capabilities remain valid offline; old servers still need an update.
  if (!(answer.capabilities ?? []).includes(DELEGATED_MOBILE_DEVICES_RUNTIME_CAPABILITY)) {
    return 'update-needed'
  }
  return health === 'available' ? 'ready' : 'unavailable'
}
