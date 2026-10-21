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
  return { ...host, deviceToken: journal.secrets.deviceToken, relay }
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
