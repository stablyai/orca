import { readEnvironmentStoreRecords } from '../../../shared/remote-runtime/host-store/runtime-environment-store-records'
import { watchRuntimeEnvironmentRegistry } from './runtime-environment-preference'
import {
  closeRemoteRuntimeRequestConnection,
  listCachedRuntimeEnvironmentIds
} from './runtime-environment-request-connections'
import { advanceRuntimeEnvironmentTransportGeneration } from './runtime-environment-transport-generation'

/** Closes a server's transports once it leaves the registry, including removals by the CLI. */
export function watchRemovedRuntimeEnvironmentConnections(userDataPath: string): () => void {
  return watchRuntimeEnvironmentRegistry(
    userDataPath,
    createRemovedRuntimeEnvironmentSweep(userDataPath),
    'Removed server connections'
  )
}

/** Each call closes cached transports of servers this registry used to list and no longer does. */
export function createRemovedRuntimeEnvironmentSweep(userDataPath: string): () => void {
  let listedIds = readListedEnvironmentIds(userDataPath) ?? new Set<string>()
  return () => {
    const currentIds = readListedEnvironmentIds(userDataPath)
    if (!currentIds) {
      return
    }
    for (const environmentId of listCachedRuntimeEnvironmentIds()) {
      if (listedIds.has(environmentId) && !currentIds.has(environmentId)) {
        advanceRuntimeEnvironmentTransportGeneration(environmentId)
        closeRemoteRuntimeRequestConnection(environmentId)
      }
    }
    listedIds = currentIds
  }
}

function readListedEnvironmentIds(userDataPath: string): Set<string> | null {
  try {
    const { environments, unreadable } = readEnvironmentStoreRecords(userDataPath, {
      requireStoreFile: true
    })
    return new Set([...environments, ...unreadable].flatMap(({ id }) => (id ? [id] : [])))
  } catch {
    return null
  }
}
