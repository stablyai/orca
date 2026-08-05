import type { MobileRelayEndpoint } from '../../../src/shared/mobile-relay-credential-contract'
import type { MobileRelayPairingJournal } from './mobile-relay-pairing-journal'
import { relayWebSocketUrl } from './mobile-endpoint-supervisor-support'
import type { HostProfile } from './types'

export function createMobileRelayRecoveredHost(
  journal: MobileRelayPairingJournal,
  relay: MobileRelayEndpoint,
  existing: HostProfile | undefined
): HostProfile {
  const journalHost = journal.metadata.host
  const host =
    existing?.publicKeyB64 === journalHost.publicKeyB64 &&
    existing.deviceToken === journal.secrets.deviceToken
      ? existing
      : journalHost
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
