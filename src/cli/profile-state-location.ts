import { getActiveProfileStateLocation as resolveActiveProfileStateLocation } from '../main/persistence/profile-state/profile-state-active-location'
import { RuntimeClientError, getDefaultUserDataPath } from './runtime-client'

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
