import {
  createProfileStateStoreForStartup,
  orcadProfileStateAuthorityMode
} from '../persistence/profile-state/profile-state-startup-authority'
import type { ProfileStateStoreFactoryResult } from '../persistence/profile-state/profile-state-store-factory'
import { ensureActiveOrcaProfile, initOrcaProfilePaths } from '../orca-profiles/profile-index-store'
import { initSshHostKeyStoreFile } from '../ssh/ssh-host-key-store'
import { emitOrcadProfileStateAuthoritySelected } from './orcad-profile-state-telemetry'

export type OrcadProfileStateProfile = {
  dataFile: string
  stateDatabaseFile: string
  profile: { id: string }
}

export type OrcadProfileStateStartup = {
  store: ProfileStateStoreFactoryResult['store']
  authority: {
    backend: ProfileStateStoreFactoryResult['backend']
    classification: ProfileStateStoreFactoryResult['classification']
    authority_mode: ReturnType<typeof orcadProfileStateAuthorityMode>
    runtime: 'orcad'
    migrated: boolean
  }
}

/** Build the headless Store and publish its authority selection at one Node-only seam. */
export function createOrcadProfileStateStartup(userDataPath: string): OrcadProfileStateStartup {
  initOrcaProfilePaths()
  const profile = ensureActiveOrcaProfile(userDataPath)
  const authorityMode = orcadProfileStateAuthorityMode()
  const result = createProfileStateStoreForStartup({
    dataFile: profile.dataFile,
    databaseFile: profile.stateDatabaseFile,
    profileId: profile.profile.id,
    runtime: 'orcad',
    authorityMode,
    storageAuthority: 'runtime'
  })
  initSshHostKeyStoreFile(profile.dataFile)
  const authority = {
    backend: result.backend,
    classification: result.classification,
    authority_mode: authorityMode,
    runtime: 'orcad' as const,
    migrated: result.migrated
  }
  emitOrcadProfileStateAuthoritySelected(authority)
  return { store: result.store, authority }
}
