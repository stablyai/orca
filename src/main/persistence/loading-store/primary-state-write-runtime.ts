import type { StoreRuntimeState } from './store-runtime-state'

export type PrimaryStateWriteOperationsRuntime = Pick<
  StoreRuntimeState,
  | 'activeViewPreference'
  | 'backupRotationInFlight'
  | 'dataFile'
  | 'dirtyProfileStateDomains'
  | 'flushOrThrow'
  | 'firstPendingSaveAt'
  | 'inFlightAsyncTmpFile'
  | 'lastDurableWriteGeneration'
  | 'lastWrittenStateHash'
  | 'pendingSnapshotFileWork'
  | 'pendingAutomationRunsAfter'
  | 'pendingWrite'
  | 'profileStateAuthority'
  | 'protectedSecrets'
  | 'quitFlushStarted'
  | 'staleTempCleanup'
  | 'state'
  | 'writeGeneration'
  | 'writeTimer'
  | 'writesFrozen'
>

export function markPrimaryStateWriteDurable(
  runtime: Pick<StoreRuntimeState, 'lastDurableWriteGeneration'>,
  generation: number
): void {
  runtime.lastDurableWriteGeneration = Math.max(runtime.lastDurableWriteGeneration, generation)
}

export function canReuseDurableProfileState(
  runtime: Pick<StoreRuntimeState, 'lastWrittenStateHash' | 'profileStateAuthority'>,
  stateHash: string
): boolean {
  if (stateHash !== runtime.lastWrittenStateHash) {
    return false
  }
  const authority = runtime.profileStateAuthority
  if (authority && !authority.assertCurrentRevision) {
    return false
  }
  authority?.assertCurrentRevision?.()
  return true
}
