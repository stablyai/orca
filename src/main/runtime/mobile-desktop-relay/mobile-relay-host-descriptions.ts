import { DELEGATED_MOBILE_DEVICES_RUNTIME_CAPABILITY } from '../../../shared/delegated-mobile-device-contract'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { describePairedServerHosts } from '../../../shared/remote-runtime/host-catalog/paired-server-hosts'
import type {
  MobileRelayHost,
  MobileRelayHostRelay
} from '../../../shared/remote-runtime/relay/mobile-relay-hosts-contract'
import { lastVerifiedRuntimeStatus } from '../../../shared/remote-runtime/host-status/runtime-host-status'
import type { RuntimeStatus } from '../../../shared/runtime-session-contracts'
import type {
  MobileDesktopRelayHostListing,
  MobileDesktopRelayListing,
  MobileDesktopRelayHosts
} from './mobile-desktop-relay-hosts'

export type DescribedRelayHost = MobileRelayHost & {
  environmentId: string
  identity: Pick<MobileDesktopRelayHostListing, 'pairingRevision' | 'runtimeId'>
}

export async function describeRelayHosts(
  hosts: Pick<MobileDesktopRelayHosts, 'list'>,
  hostLabelOverrides: ReadonlyMap<ExecutionHostId, string> = new Map()
): Promise<DescribedRelayHost[]> {
  return describeRelayHostListing(await hosts.list(), hostLabelOverrides)
}

export function describeRelayHostListing(
  listing: MobileDesktopRelayListing,
  hostLabelOverrides: ReadonlyMap<ExecutionHostId, string> = new Map()
): DescribedRelayHost[] {
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
        relay: relayVerdict(host.health, answer),
        ...(host.installationId ? { installationId: host.installationId } : {}),
        ...(identity.stoppedOnDesktop ? { stoppedOnDesktop: true as const } : {}),
        ...(identity.unavailableOnDesktop ? { unavailableOnDesktop: true as const } : {})
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
