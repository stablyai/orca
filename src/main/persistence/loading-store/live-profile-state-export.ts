import type { StoreRuntimeState } from './store-runtime-state'
import type { AsyncProfileStateAuthority } from './profile-state-authority'
import {
  enqueuePrimaryStateOperation,
  writeToDiskAsync,
  type PrimaryStateWriteOperations
} from './primary-state-writes'
export function enqueueProfileExport(
  runtime: StoreRuntimeState,
  writes: PrimaryStateWriteOperations,
  exportState: (authority: AsyncProfileStateAuthority) => Promise<number | undefined>
): Promise<number | undefined> {
  if (runtime.writesFrozen || runtime.quitFlushStarted || runtime.profileMaintenancePending) {
    return Promise.reject(new Error('Cannot export finalized profile persistence'))
  }
  const authority = runtime.profileStateAuthority
  if (!authority?.asynchronous) {
    return Promise.resolve(undefined)
  }
  return enqueuePrimaryStateOperation(writes, async () => {
    runtime.dirtyProfileStateDomains = null
    if (!(await writeToDiskAsync(writes))) {
      throw new Error('Profile state changed while preparing its export')
    }
    return exportState(authority)
  })
}
