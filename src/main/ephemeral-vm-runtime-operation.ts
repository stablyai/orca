import { runKeyedSerializedOperation } from './cli/keyed-promise-queue'
import { listEphemeralVmRuntimes } from '../shared/ephemeral-vm-runtime-store'
import type { EphemeralVmRuntimeRecord } from '../shared/ephemeral-vm-runtimes'

const operations = new Map<string, Promise<void>>()

export function runEphemeralVmRuntimeOperation<T>(
  userDataPath: string,
  runtimeId: string,
  operation: () => Promise<T>
): Promise<T> {
  const key = `${userDataPath}\0${runtimeId}`
  // Queued cleanup cannot be stopped through the active provider's abort controller.
  if (operations.has(key)) {
    return Promise.reject(
      new Error('A Cloud VM lifecycle operation is already in progress. Retry after it finishes.')
    )
  }
  return runKeyedSerializedOperation(operations, key, operation)
}

export function runEphemeralVmWorkspaceOperation(
  userDataPath: string,
  workspaceId: string,
  operation: (runtime: EphemeralVmRuntimeRecord) => Promise<EphemeralVmRuntimeRecord>
): Promise<EphemeralVmRuntimeRecord | null> {
  const find = () =>
    listEphemeralVmRuntimes(userDataPath).find(
      (entry) =>
        entry.workspaceId === workspaceId &&
        entry.status !== 'cleaned' &&
        entry.status !== 'cleanup_pending'
    )
  const selected = find()
  if (!selected?.repoId) {
    return Promise.resolve(null)
  }
  return runEphemeralVmRuntimeOperation(userDataPath, selected.id, async () => {
    const runtime = find()
    return runtime?.repoId && runtime.id === selected.id ? operation(runtime) : null
  })
}
