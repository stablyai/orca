import { Store } from '../loading-store/store'
import {
  prepareProfileStateStore,
  type ProfileStateStoreFactoryOptions,
  type ProfileStateStoreFactoryResult
} from './profile-state-store-factory'
import {
  ProfileStateWorkerAuthority,
  type ProfileStateWorkerAuthorityOptions
} from './profile-state-worker-authority'

/** Publish state only after a worker owns its exact bootstrap revision. */
export async function createLiveProfileStateStore(
  options: ProfileStateStoreFactoryOptions,
  workerOptions: ProfileStateWorkerAuthorityOptions = {}
): Promise<ProfileStateStoreFactoryResult> {
  const { initialState: initial, ...prepared } = prepareProfileStateStore(options)

  // Consume before retirement to preserve the bootstrap revision fence.
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
