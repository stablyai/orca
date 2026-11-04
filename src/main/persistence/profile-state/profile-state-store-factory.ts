import type { AutomationStorageAuthority } from '../scheduling-automations/automation-owner-projection'
import type { ProfileStateAuthorityInitialState } from '../loading-store/profile-state-authority'
import type { ProfileStateSqliteAuthority } from './profile-state-sqlite-authority'
import { Store } from '../loading-store/store'
import { bootstrapProfileStateAuthority } from './profile-state-authority-bootstrap'
import type { ProfileStateStorageClassification } from './profile-state-storage-classification'
import { initializeProfileWorkspaceSurfaces } from '../../workspace-surfaces/surface-startup'

export type ProfileStateStoreFactoryOptions = {
  userDataPath?: string
  dataFile: string
  databaseFile: string
  profileId: string
  storageAuthority?: AutomationStorageAuthority
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
  backend: 'sqlite'
  classification: ProfileStateStorageClassification
  migrated: boolean
}

export function createProfileStateStore(
  options: ProfileStateStoreFactoryOptions
): ProfileStateStoreFactoryResult {
  const { initialState, ...prepared } = prepareProfileStateStore(options)
  let store: Store | undefined
  try {
    store = new Store({
      dataFile: options.dataFile,
      storageAuthority: options.storageAuthority,
      profileStateAuthority: initialState.authority,
      initialAuthorityState: initialState
    })
    store.initializeWorkspaceSurfacesSync()
    store.pruneDeregisteredTerminalSurfacesSync()
    return { ...prepared, store }
  } catch (error) {
    store?.freezeWrites()
    // Failed Store construction has not taken authority ownership yet.
    initialState.authority.close?.()
    throw error
  }
}

type PreparedProfileStateStore = Omit<ProfileStateStoreFactoryResult, 'store'> & {
  initialState: ProfileStateAuthorityInitialState<ProfileStateSqliteAuthority>
}

/** Share admission between live workers and synchronous offline operations. */
export function prepareProfileStateStore(
  options: ProfileStateStoreFactoryOptions
): PreparedProfileStateStore {
  const bootstrap = bootstrapProfileStateAuthority({
    ...options,
    allowEmptyProfileState: true
  })
  const authority = bootstrap.authority
  if (authority === undefined) {
    throw new ProfileStateStoreFactoryError(
      'Writable profiles require SQLite database and backup support. Use Orca or its pinned Node runtime.'
    )
  }

  return {
    initialState: initializeProfileWorkspaceSurfaces(bootstrap.initialState),
    backend: 'sqlite',
    classification: bootstrap.classification,
    migrated: bootstrap.migrated
  }
}
