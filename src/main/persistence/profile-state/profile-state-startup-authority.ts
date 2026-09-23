import type { AutomationStorageAuthority } from '../scheduling-automations/automation-owner-projection'
import { isProfileStateSqliteAvailable } from './profile-state-database'
import {
  createProfileStateStore,
  type ProfileStateStoreAuthorityMode,
  type ProfileStateStoreFactoryOptions,
  type ProfileStateStoreFactoryResult
} from './profile-state-store-factory'

/** Runtime roots sharing the profile-state selection boundary. */
export type ProfileStateStartupRuntime = 'desktop' | 'orcad'

export type ProfileStateStartupAuthorityOptions = Omit<
  ProfileStateStoreFactoryOptions,
  'authorityMode' | 'storageAuthority'
> & {
  runtime: ProfileStateStartupRuntime
  authorityMode: ProfileStateStoreAuthorityMode
  storageAuthority: AutomationStorageAuthority
}

export class ProfileStateStartupAuthorityError extends Error {
  readonly code = 'orcad-sqlite-authority-unsupported' as const

  constructor() {
    super('orcad requires node:sqlite database and backup support to select SQLite profile state')
    this.name = 'ProfileStateStartupAuthorityError'
  }
}

/** Desktop startup establishes SQLite for legacy and empty profiles. */
export function desktopProfileStateAuthorityMode(): ProfileStateStoreAuthorityMode {
  return 'sqlite-candidate'
}

/**
 * Select orcad's authority from the runtime capability, without raising the
 * Node floor shared by the relay and older remote hosts.
 *
 * A capable host may establish SQLite for a JSON-only profile. An older host
 * stays on the legacy path, while the factory still refuses to open an
 * already-established database it cannot validate.
 */
export function orcadProfileStateAuthorityMode(
  sqliteAvailable = isProfileStateSqliteAvailable()
): ProfileStateStoreAuthorityMode {
  return sqliteAvailable ? 'sqlite-candidate' : 'legacy'
}

/** Construct both runtimes through the same validated authority boundary. */
export function createProfileStateStoreForStartup(
  options: ProfileStateStartupAuthorityOptions
): ProfileStateStoreFactoryResult {
  if (
    options.runtime === 'orcad' &&
    options.authorityMode === 'sqlite-candidate' &&
    !isProfileStateSqliteAvailable()
  ) {
    throw new ProfileStateStartupAuthorityError()
  }
  return createProfileStateStore(options)
}
