import { openProfileStateDatabaseReadOnly } from '../../persistence/profile-state/database/profile-state-database'
import { readProfileStateRevision } from '../../persistence/profile-state/database/profile-state-revision'
import { readProfileStateSnapshot } from '../../persistence/profile-state/documents/profile-state-documents'
import { Store } from '../../persistence/loading-store/store'
import {
  getOrcaProfileDataFile,
  getOrcaProfileStateDatabaseFile
} from '../../orca-profiles/profile-storage-paths'

// Desktop owns profile writes. The chat runtime reads a consistent catalog, including folder workspaces.
export function openChatHostProfile(userData: string, profileId: string) {
  const { db } = openProfileStateDatabaseReadOnly(
    getOrcaProfileStateDatabaseFile(profileId, userData),
    profileId
  )
  const dataFile = getOrcaProfileDataFile(profileId, userData)
  function snapshot() {
    const { json, revision } = readProfileStateSnapshot(db)
    return { store: new Store({ dataFile, serializedState: json }), revision }
  }
  let current = snapshot()
  return {
    store: new Proxy(current.store, {
      get(_target, property: keyof Store) {
        const value = current.store[property]
        return typeof value === 'function' ? value.bind(current.store) : value
      }
    }),
    refresh() {
      if (readProfileStateRevision(db) === current.revision) {
        return false
      }
      current = snapshot()
      return true
    },
    close: () => db.close()
  }
}
