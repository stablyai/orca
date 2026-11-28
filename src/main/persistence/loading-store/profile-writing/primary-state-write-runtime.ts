import type { StoreRuntimeState } from '../store-runtime-state'
import { suspendGithubCachePersistence } from '../github-cache/github-cache-persistence'

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
  | 'githubCachePersistTimer'
  | 'githubCacheRows'
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
  | 'workspaceSessionWriteListeners'
  | 'workspaceSessionOperationListeners'
  | 'layoutEditorViews'
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
  // Throwing callbacks supply no rollback; freeze persistence rather than commit partial edits.
  runtime.writesFrozen = true
  runtime.quitFlushStarted = true
  runtime.fatalMutationError = error instanceof Error ? error : new Error(String(error))
  if (runtime.writeTimer) {
    clearTimeout(runtime.writeTimer)
    runtime.writeTimer = null
  }
  suspendGithubCachePersistence(runtime)
  const authority = runtime.profileStateAuthority
  // Saving stays off until restart; say so rather than leave a retry notice up.
  if (authority?.asynchronous) {
    authority.reportSavingStopped?.(error)
  }
  await authority?.close?.()
}
