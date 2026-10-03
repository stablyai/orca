import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { getEnvironmentStorePath, listEnvironments } from '../../shared/runtime-environment-store'

// Why: `orca environment rm` runs in a separate CLI process and only rewrites the store, so the
// app's cached transports are the only thing left describing an environment that no longer exists.
type RuntimeEnvironmentRemovalWatch = {
  getUserDataPath: () => string
  retire: (environmentId: string) => Promise<void>
}

let removalWatch: RuntimeEnvironmentRemovalWatch | null = null
const storedEnvironmentIds = new Set<string>()

export function setRuntimeEnvironmentRemovalWatch(
  watch: RuntimeEnvironmentRemovalWatch | null
): void {
  removalWatch = watch
  storedEnvironmentIds.clear()
}

/**
 * Records the watched store listing this environment, so a later absence becomes evidence.
 *
 * Why a caller's `userDataPath` beats reading again: the caller already resolved the environment
 * out of that store, and a removal landing between its read and ours would lose the observation
 * for good. The path still has to be the watched one, or a foreign store's id would be recorded.
 */
export function noteRuntimeEnvironmentStored(environmentId: string, userDataPath?: string): void {
  const watch = removalWatch
  if (userDataPath !== undefined) {
    if (watch && resolve(watch.getUserDataPath()) === resolve(userDataPath)) {
      storedEnvironmentIds.add(environmentId)
    }
    return
  }
  if (watchedStoreListsEnvironment(environmentId) === true) {
    storedEnvironmentIds.add(environmentId)
  }
}

/**
 * Why positive observation only: a missing store reads as zero environments rather than throwing,
 * so anything less than "this store was read and the id is not in it" would retire every
 * environment at once. An unknown store keeps the pre-fix answer, which is to stay connected.
 */
export function isRuntimeEnvironmentRemoved(environmentId: string): boolean {
  const listed = watchedStoreListsEnvironment(environmentId)
  if (listed === null) {
    return false
  }
  if (listed) {
    storedEnvironmentIds.add(environmentId)
    return false
  }
  // Why: callers may resolve an environment from another user-data path (dev redirect, or the
  // canonical path captured before app.setName). Absence from a store that never listed the id
  // says nothing about it, so only an id this store once held can be judged removed.
  return storedEnvironmentIds.has(environmentId)
}

/** `null` when the store cannot be read, so the caller keeps the pre-fix answer. */
function watchedStoreListsEnvironment(environmentId: string): boolean | null {
  const watch = removalWatch
  if (!watch) {
    return null
  }
  try {
    const userDataPath = watch.getUserDataPath()
    if (!existsSync(getEnvironmentStorePath(userDataPath))) {
      return null
    }
    return listEnvironments(userDataPath).some((entry) => entry.id === environmentId)
  } catch {
    return null
  }
}

export function retireRemovedRuntimeEnvironment(environmentId: string): void {
  const watch = removalWatch
  if (!watch) {
    return
  }
  try {
    void watch.retire(environmentId).catch(warnRetirementFailed)
  } catch (error) {
    warnRetirementFailed(error)
  }
}

function warnRetirementFailed(error: unknown): void {
  console.warn('[runtime-environments] removed environment retirement failed:', error)
}
