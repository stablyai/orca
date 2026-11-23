import { createProfileStateStoreForStartup } from '../../persistence/profile-state/startup/profile-state-startup-authority'
import type { ProfileStateStoreFactoryResult } from '../../persistence/profile-state/startup/profile-state-store-factory'
import { ensureActiveOrcaProfile } from '../../orca-profiles/profile-index-store'
import { initializeTeamCapabilities } from '../../orca-profiles/cloud-auth/initialize-team-capabilities'
import { initOrcaProfilePaths } from '../../orca-profiles/profile-storage-paths'
import { initSshHostKeyStoreFile } from '../../ssh/host-keys/ssh-host-key-store'
import { initOrcadHeldFenceTokenFile } from '../../managed-server/activation/orcad-held-fence-tokens'
import { emitOrcadProfileStateAuthoritySelected } from './orcad-profile-state-telemetry'
import { isWslHostOrcadProcess } from '../../wsl/filesystem/wsl-guest-windows-drive-path'
import { recordOrcadServedProfile } from '../orcad-served-profile'

/** Retire idle SQLite writer threads across hosts (~13-15 MB); next write reopens in ~22 ms. */
export const WSL_HOST_PROFILE_WRITER_IDLE_STOP_MS = 15_000
export const ORCAD_PROFILE_WRITER_IDLE_STOP_MS = 15_000

export function orcadProfileWriterIdleStopMs(
  isWslHost: () => boolean = isWslHostOrcadProcess
): number {
  return isWslHost() ? WSL_HOST_PROFILE_WRITER_IDLE_STOP_MS : ORCAD_PROFILE_WRITER_IDLE_STOP_MS
}

type OrcadProfileStateStartup = {
  store: ProfileStateStoreFactoryResult['store']
  authority: {
    backend: ProfileStateStoreFactoryResult['backend']
    classification: ProfileStateStoreFactoryResult['classification']
    authority_mode: 'sqlite-established'
    runtime: 'orcad'
    migrated: boolean
  }
}

export async function createOrcadProfileStateStartup(
  userDataPath: string
): Promise<OrcadProfileStateStartup> {
  initOrcaProfilePaths()
  const profile = ensureActiveOrcaProfile(userDataPath)
  await initializeTeamCapabilities(userDataPath, profile.profile)
  // Real persistence avoids falsely empty RPCs; headless authority keeps automations owned by this host.
  const result = await createProfileStateStoreForStartup({
    userDataPath,
    dataFile: profile.dataFile,
    databaseFile: profile.stateDatabaseFile,
    profileId: profile.profile.id,
    runtime: 'orcad',
    storageAuthority: 'runtime',
    writerIdleStopMs: orcadProfileWriterIdleStopMs()
  })
  const authority = {
    backend: result.backend,
    classification: result.classification,
    authority_mode: 'sqlite-established' as const,
    runtime: 'orcad' as const,
    migrated: result.migrated
  }
  try {
    initSshHostKeyStoreFile(profile.dataFile)
    initOrcadHeldFenceTokenFile(profile.dataFile)
    emitOrcadProfileStateAuthoritySelected(authority)
    recordOrcadServedProfile(profile.profile.id)
    return { store: result.store, authority }
  } catch (error) {
    try {
      await result.store.freezeWritesAsync()
    } catch (closeError) {
      console.error(
        '[persistence] Failed to close profile persistence after startup failure:',
        closeError
      )
    }
    throw error
  }
}
