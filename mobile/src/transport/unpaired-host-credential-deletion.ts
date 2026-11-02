import { deleteHostDeviceToken } from './host-device-token-store'
import {
  clearHostCredentialWriteRevision,
  getHostCredentialWriteRevision
} from './host-credential-write-revision'
import { deleteMobileRelayCredentialBundle } from './mobile-relay-credential-bundle'
import { deleteMobileRelayDirectUpgradeJournal } from './mobile-relay-direct-upgrade-journal'

type DeletionDependencies = {
  waitForHostMutations: () => Promise<void>
  hasStoredHost: (hostId: string) => Promise<boolean>
  onDeleted: (hostId: string) => void
}

export function createUnpairedHostCredentialDeletion(dependencies: DeletionDependencies) {
  function writeRevisionChanged(hostId: string, writeRevision: number): boolean {
    return getHostCredentialWriteRevision(hostId) !== writeRevision
  }

  function assertWriteRevisionUnchanged(hostId: string, writeRevision: number): void {
    if (writeRevisionChanged(hostId, writeRevision)) {
      throw new Error('credential write superseded cleanup')
    }
  }

  async function shouldSkip(hostId: string, writeRevision: number): Promise<boolean> {
    await dependencies.waitForHostMutations()
    if (await dependencies.hasStoredHost(hostId)) {
      return true
    }
    assertWriteRevisionUnchanged(hostId, writeRevision)
    return false
  }

  return async (hostId: string, writeRevision: number): Promise<void> => {
    if (await shouldSkip(hostId, writeRevision)) {
      return
    }
    assertWriteRevisionUnchanged(hostId, writeRevision)
    await deleteHostDeviceToken(hostId)
    if (await shouldSkip(hostId, writeRevision)) {
      return
    }
    assertWriteRevisionUnchanged(hostId, writeRevision)
    await deleteMobileRelayCredentialBundle(hostId)
    if (await shouldSkip(hostId, writeRevision)) {
      return
    }
    assertWriteRevisionUnchanged(hostId, writeRevision)
    await deleteMobileRelayDirectUpgradeJournal(hostId)
    if (await shouldSkip(hostId, writeRevision)) {
      return
    }
    assertWriteRevisionUnchanged(hostId, writeRevision)
    clearHostCredentialWriteRevision(hostId)
    dependencies.onDeleted(hostId)
  }
}
