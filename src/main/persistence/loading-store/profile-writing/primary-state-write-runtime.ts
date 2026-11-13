import type { StoreRuntimeState } from '../store-runtime-state'

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
  | 'profileStateSplitSnapshots'
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
  runtime.profileStateSplitSnapshots.clear()
  runtime.fatalMutationError = error instanceof Error ? error : new Error(String(error))
  if (runtime.writeTimer) {
    clearTimeout(runtime.writeTimer)
    runtime.writeTimer = null
  }
  await runtime.profileStateAuthority?.close?.()
}

export function capturePrimaryStateWriteIntent(runtime: PrimaryStateWriteOperationsRuntime) {
  const generation = runtime.writeGeneration
  const dirtyDomains = runtime.dirtyProfileStateDomains
  const automationRuns = runtime.pendingAutomationRunsAfter
  runtime.dirtyProfileStateDomains = new Set()
  runtime.pendingAutomationRunsAfter = undefined

  const restoreIntent = (): void => {
    if (dirtyDomains === null) {
      runtime.dirtyProfileStateDomains = null
    } else if (runtime.dirtyProfileStateDomains !== null) {
      for (const domain of dirtyDomains) {
        runtime.dirtyProfileStateDomains.add(domain)
      }
    }
    if (automationRuns === undefined || runtime.pendingAutomationRunsAfter !== undefined) {
      return
    }
    // A run list replaced while this write was in flight is newer; save it as a whole row instead.
    if (automationRuns === runtime.state.automationRuns) {
      runtime.pendingAutomationRunsAfter = automationRuns
    } else {
      runtime.dirtyProfileStateDomains?.add('automationRuns')
    }
  }

  return { generation, dirtyDomains, automationRuns, restoreIntent }
}
