import { deleteHostDeviceToken } from './host-device-token-store'
import { deleteMobileRelayCredentialBundle } from './mobile-relay-credential-bundle'
import { deleteMobileRelayDirectUpgradeJournal } from './mobile-relay-direct-upgrade-journal'

export async function deleteHostCredentials(hostId: string): Promise<void> {
  await deleteHostDeviceToken(hostId)
  await deleteMobileRelayCredentialBundle(hostId)
  await deleteMobileRelayDirectUpgradeJournal(hostId)
}

export function createRemovedHostCredentialDelete(
  hostExists: (hostId: string) => Promise<boolean>
): (hostId: string) => Promise<void> {
  return async (hostId) => {
    if (!(await hostExists(hostId))) {
      await deleteHostCredentials(hostId)
    }
  }
}
