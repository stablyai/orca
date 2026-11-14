import { getActiveProfileStateLocation as resolveActiveProfileStateLocation } from '../../main/persistence/profile-state/offline-access/profile-state-active-location'
import { RuntimeClientError } from '../runtime/connection/types'
import { getDefaultUserDataPath } from '../runtime/profile/metadata'

export function getActiveProfileStateLocation(userDataPath = getDefaultUserDataPath()) {
  try {
    return resolveActiveProfileStateLocation(userDataPath)
  } catch (error) {
    throw new RuntimeClientError(
      'runtime_error',
      error instanceof Error ? error.message : String(error)
    )
  }
}
