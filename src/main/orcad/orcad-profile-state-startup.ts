import { createProfileStateStoreForStartup } from '../persistence/profile-state/profile-state-startup-authority'
import type { ProfileStateStoreFactoryResult } from '../persistence/profile-state/profile-state-store-factory'
import { ensureActiveOrcaProfile, initOrcaProfilePaths } from '../orca-profiles/profile-index-store'
import { initSshHostKeyStoreFile } from '../ssh/ssh-host-key-store'
import { initOrcadHeldFenceTokenFile } from '../ssh/orcad-held-fence-tokens'
import { emitOrcadProfileStateAuthoritySelected } from './orcad-profile-state-telemetry'
import { isWslHostOrcadProcess } from '../ipc/wsl-guest-windows-drive-path'

/** WSL hosts are held to a per-distro memory budget; the idle writer thread costs ~13-15 MB. */
export const WSL_HOST_PROFILE_WRITER_IDLE_STOP_MS = 60_000

/** SSH hosts and the desktop keep their writer thread running. */
export function orcadProfileWriterIdleStopMs(
  isWslHost: () => boolean = isWslHostOrcadProcess
): number | undefined {
  return isWslHost() ? WSL_HOST_PROFILE_WRITER_IDLE_STOP_MS : undefined
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
