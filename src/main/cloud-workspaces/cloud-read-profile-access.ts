// The active Orca profile's reader key and read pins, as the cloud workspaces service consumes them.
import { getCloudReaderKeyStore } from './cloud-reader-key-store'
import type { ReaderKeyAccess, ReadPinAccess } from './cloud-read-snapshot-reader'
import { getCloudReadPinStore } from './cloud-read-pin-store'
import { ensureActiveOrcaProfile } from '../orca-profiles/profile-index-store'

/** The active Orca profile's reader key; registrations follow its signed-in user and account. */
export function profileReaderKey(userDataPath: string): ReaderKeyAccess {
  return {
    identity: () => {
      const active = ensureActiveOrcaProfile(userDataPath)
      const cloud = active.profile.cloud
      return cloud
        ? JSON.stringify([active.profile.id, cloud.userId ?? null, cloud.activeOrgId ?? null])
        : null
    },
    load: () =>
      getCloudReaderKeyStore(userDataPath).load(ensureActiveOrcaProfile(userDataPath).profile.id),
    peek: () =>
      getCloudReaderKeyStore(userDataPath).peek(ensureActiveOrcaProfile(userDataPath).profile.id)
  }
}

/** Signer and rollback pins in the active profile's directory, keyed by account and workspace. */
export function profileReadPins(userDataPath: string): ReadPinAccess {
  const store = getCloudReadPinStore(userDataPath)
  const profileId = () => ensureActiveOrcaProfile(userDataPath).profile.id
  return {
    get: (identity, sandboxId) => store.get(profileId(), `${identity}\0${sandboxId}`),
    update: (identity, sandboxId, change) =>
      store.update(profileId(), `${identity}\0${sandboxId}`, change)
  }
}
