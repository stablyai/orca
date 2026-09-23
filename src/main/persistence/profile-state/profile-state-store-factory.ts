import type { AutomationStorageAuthority } from '../scheduling-automations/automation-owner-projection'
import type { ProfileStateAuthorityInitialState } from '../loading-store/profile-state-authority'
import { Store } from '../loading-store/store'
import { bootstrapProfileStateAuthority } from './profile-state-authority-bootstrap'
import {
  classifyProfileStateStorage,
  type ProfileStateStorageClassification
} from './profile-state-storage-classification'
import { assertNoRetainedProfileStateExports } from './profile-state-recovery-required'

/** Legacy refuses SQLite; candidate migrates; established only reopens existing SQLite. */
export type ProfileStateStoreAuthorityMode =
  | 'legacy'
  | 'sqlite-candidate'
  /** Use SQLite only when a prior migration already established it. */
  | 'sqlite-established'

export type ProfileStateStoreFactoryOptions = {
  dataFile: string
  databaseFile: string
  profileId: string
  storageAuthority?: AutomationStorageAuthority
  authorityMode?: ProfileStateStoreAuthorityMode
}

export class ProfileStateStoreFactoryError extends Error {
  readonly code = 'profile-state-authority-required' as const

  constructor(message: string) {
    super(message)
    this.name = 'ProfileStateStoreFactoryError'
  }
}

export type ProfileStateStoreFactoryResult = {
  store: Store
  backend: 'json' | 'sqlite'
  classification: ProfileStateStorageClassification
  migrated: boolean
}

/** Centralize authority selection for desktop, orcad and offline callers. */
export function createProfileStateStore(
  options: ProfileStateStoreFactoryOptions
): ProfileStateStoreFactoryResult {
  const authorityMode = options.authorityMode ?? 'legacy'
  const classification = classifyProfileStateStorage(options.dataFile, options.databaseFile)
  if (classification === 'json-only' || classification === 'neither') {
    assertNoRetainedProfileStateExports(options)
  }
  if (authorityMode === 'legacy') {
    if (classification === 'sqlite-only' || classification === 'both') {
      throw new ProfileStateStoreFactoryError(
        'SQLite profile state is present; construct the Store with sqlite-candidate authority mode'
      )
    }
    return {
      store: createLegacyStore(options),
      backend: 'json',
      classification,
      migrated: false
    }
  }

  if (
    authorityMode === 'sqlite-established' &&
    (classification === 'neither' || classification === 'json-only')
  ) {
    return {
      store: createLegacyStore(options),
      backend: 'json',
      classification,
      migrated: false
    }
  }

  const bootstrap = bootstrapProfileStateAuthority({
    ...options,
    allowEmptyProfileState: authorityMode === 'sqlite-candidate'
  })
  const authority = bootstrap.authority
  if (authority === undefined) {
    return {
      store: createLegacyStore(options),
      backend: 'json',
      classification: bootstrap.classification,
      migrated: bootstrap.migrated
    }
  }

  return {
    store: createSqliteStore(options, bootstrap.initialState),
    backend: 'sqlite',
    classification: bootstrap.classification,
    migrated: bootstrap.migrated
  }
}

function createLegacyStore(options: ProfileStateStoreFactoryOptions): Store {
  return new Store({
    dataFile: options.dataFile,
    ...(options.storageAuthority === undefined
      ? {}
      : { storageAuthority: options.storageAuthority })
  })
}

function createSqliteStore(
  options: ProfileStateStoreFactoryOptions,
  initialState: ProfileStateAuthorityInitialState
): Store {
  try {
    return new Store({
      dataFile: options.dataFile,
      profileStateAuthority: initialState.authority,
      initialAuthorityState: initialState,
      ...(options.storageAuthority === undefined
        ? {}
        : { storageAuthority: options.storageAuthority })
    })
  } catch (error) {
    // Store construction owns the authority only after its load boundary succeeds.
    initialState.authority.close?.()
    throw error
  }
}
