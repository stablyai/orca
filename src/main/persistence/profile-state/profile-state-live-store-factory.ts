import { Store } from '../loading-store/store'
import {
  prepareProfileStateStore,
  type ProfileStateStoreFactoryOptions,
  type ProfileStateStoreFactoryResult
} from './profile-state-store-factory'
import { ProfileStateWorkerAuthority } from './profile-state-worker-authority'

/** Publish live state only after its exact bootstrap revision has a worker owner. */
export async function createLiveProfileStateStore(
  options: ProfileStateStoreFactoryOptions,
  workerOptions: {
    workerPath?: string
    backupWorkerPath?: string
    onFailure?: (error: Error) => void
  } = {}
): Promise<ProfileStateStoreFactoryResult> {
  const { initialState: initial, ...prepared } = prepareProfileStateStore(options)
  if (!initial) {
    return {
      ...prepared,
      store: new Store({ dataFile: options.dataFile, storageAuthority: options.storageAuthority })
    }
  }

  // Consume before retirement: the bootstrap snapshot carries the original revision fence.
  const parsed = initial.takeParsedState?.()
  const serializedState = initial.serializedState
  const authority = new ProfileStateWorkerAuthority(
    initial.authority.retireForWorker(),
    workerOptions
  )
  try {
    await authority.ready
    const initialAuthorityState = initial.takeParsedState
      ? { authority, takeParsedState: () => parsed }
      : { authority, serializedState }
    return {
      ...prepared,
      store: new Store({
        dataFile: options.dataFile,
        storageAuthority: options.storageAuthority,
        profileStateAuthority: authority,
        initialAuthorityState: {
          ...initialAuthorityState,
          unboundPaneAliases: initial.unboundPaneAliases
        }
      })
    }
  } catch (error) {
    try {
      await authority.close()
    } catch (closeError) {
      console.error('[persistence] Failed to close a refused profile writer:', closeError)
    }
    throw error
  }
}
