import type { StoreRuntimeState } from './store-runtime-state'

export type PrimaryStateWriteOperationsRuntime = Pick<
  StoreRuntimeState,
  | 'activeViewPreference'
  | 'dataFile'
  | 'dirtyProfileStateDomains'
  | 'durableMutationPhase'
  | 'fatalMutationError'
  | 'flushOrThrow'
  | 'runDurableMutation'
  | 'firstPendingSaveAt'
  | 'lastDurableWriteGeneration'
  | 'lastWrittenStateHash'
  | 'pendingSnapshotFileWork'
  | 'pendingAutomationRunsAfter'
  | 'pendingWrite'
  | 'profileMaintenancePending'
  | 'profileStateAuthority'
  | 'protectedSecrets'
  | 'quitFlushStarted'
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
  if (authority?.asynchronous) {
    throw new Error('Live profile persistence requires an awaited revision check')
  }
  if (authority && !authority.assertCurrentRevision) {
    return false
  }
  authority?.assertCurrentRevision?.()
  return true
}

export async function stopAfterFailedPrimaryStateMutation(
  runtime: PrimaryStateWriteOperationsRuntime,
  error: unknown
): Promise<void> {
  // A throwing callback never returns its rollback; do not persist a partial edit.
  runtime.writesFrozen = true
  runtime.quitFlushStarted = true
  runtime.fatalMutationError = error instanceof Error ? error : new Error(String(error))
  if (runtime.writeTimer) {
    clearTimeout(runtime.writeTimer)
    runtime.writeTimer = null
  }
  await runtime.profileStateAuthority?.close?.()
}
