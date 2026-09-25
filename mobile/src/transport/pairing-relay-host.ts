import type {
  DeviceCredentialInstalled,
  MobileRelayEndpoint
} from '../../../src/shared/mobile-relay-credential-contract'
import type { MobileRelayPairingJournal } from './mobile-relay-pairing-journal'
import type { HostProfile } from './types'

export function relayHost(
  journal: MobileRelayPairingJournal,
  relay: MobileRelayEndpoint
): HostProfile {
  const host = journal.metadata.host
  return {
    ...host,
    deviceToken: journal.secrets.deviceToken,
    endpoints: [
      { id: 'direct-primary', kind: 'lan', url: host.endpoint },
      { id: 'relay-primary', kind: 'relay', url: relayWebSocketUrl(relay) }
    ],
    relayHostId: relay.relayHostId,
    relay
  }
}

export function relayWebSocketUrl(relay: MobileRelayEndpoint): string {
  const url = new URL(relay.cellUrl)
  url.protocol = 'wss:'
  url.pathname = `/v1/connect/${encodeURIComponent(relay.relayHostId)}`
  return url.toString()
}

export function assertCommittedInstall(
  status:
    | { state: 'not-found' }
    | { state: 'committed'; result: DeviceCredentialInstalled }
    | undefined,
  installed: DeviceCredentialInstalled
): void {
  if (
    !status ||
    status.state !== 'committed' ||
    JSON.stringify(status.result) !== JSON.stringify(installed)
  ) {
    throw new Error('relay credential install was not authoritatively reconciled')
  }
}
