import type { AutomationStorageAuthority } from '../scheduling-automations/automation-owner-projection'
import { isProfileStateSqliteAvailable } from './profile-state-database'
import type {
  ProfileStateStoreFactoryOptions,
  ProfileStateStoreFactoryResult
} from './profile-state-store-factory'
import { createLiveProfileStateStore } from './profile-state-live-store-factory'

/** Runtime roots sharing the profile-state selection boundary. */
export type ProfileStateStartupRuntime = 'desktop' | 'orcad'

export type ProfileStateStartupAuthorityOptions = Omit<
  ProfileStateStoreFactoryOptions,
  'storageAuthority'
> & {
  runtime: ProfileStateStartupRuntime
  storageAuthority: AutomationStorageAuthority
  onPersistenceFailure?: (error: Error) => void
}

export class ProfileStateStartupAuthorityError extends Error {
  readonly code = 'orcad-sqlite-authority-unsupported' as const

  constructor() {
    super(
      'orcad requires SQLite database and backup support. Launch through its bundled Bun runtime.'
    )
    this.name = 'ProfileStateStartupAuthorityError'
  }
}

/** Construct both runtimes through the same validated authority boundary. */
export async function createProfileStateStoreForStartup(
  options: ProfileStateStartupAuthorityOptions
): Promise<ProfileStateStoreFactoryResult> {
  if (options.runtime === 'orcad' && !isProfileStateSqliteAvailable()) {
    throw new ProfileStateStartupAuthorityError()
  }
  return createLiveProfileStateStore(options, {
    onFailure:
      options.onPersistenceFailure ??
      ((error) =>
        console.error('[persistence] Saving has stopped. Restart Orca before continuing.', error))
  })
}
