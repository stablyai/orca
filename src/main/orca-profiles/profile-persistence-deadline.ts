import type { Store } from '../persistence'
import type { ProfileStateMaintenance } from '../persistence/loading-store/profile-state-authority'
import type { ProfileStateMaintenanceOptions } from '../persistence/loading-store/profile-state-maintenance'

const PROFILE_PERSISTENCE_TIMEOUT_MS = 60_000

export async function flushActiveProfileBeforeFileMutation(
  store: Pick<Store, 'beginProfileMaintenance'>,
  options: Pick<ProfileStateMaintenanceOptions, 'flush'> = {}
): Promise<ProfileStateMaintenance> {
  return withinProfilePersistenceDeadline((signal) =>
    store.beginProfileMaintenance({ ...options, signal }).then(async (handle) => {
      if (signal.aborted && options.flush !== false) {
        await handle.resume()
        throw new Error('orca_profile_persistence_timeout')
      }
      return handle
    })
  )
}

export function flushActiveProfileBeforeRelaunch(
  store: Pick<Store, 'flushPendingOrThrowAsync'>
): Promise<void> {
  return withinProfilePersistenceDeadline((signal) => store.flushPendingOrThrowAsync({ signal }))
}

async function withinProfilePersistenceDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | null = null
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort()
      reject(new Error('orca_profile_persistence_timeout'))
    }, PROFILE_PERSISTENCE_TIMEOUT_MS)
  })
  try {
    return await Promise.race([operation(controller.signal), deadline])
  } finally {
    if (timeout) {
      clearTimeout(timeout)
    }
  }
}
