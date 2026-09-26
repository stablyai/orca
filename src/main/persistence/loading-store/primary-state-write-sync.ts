import { writeSelectiveProfileState } from './profile-state-selective-write'
import type { PrimaryStateWriteOperationsContext } from './primary-state-write-context'
import {
  canReuseDurableProfileState,
  markPrimaryStateWriteDurable
} from './primary-state-write-runtime'

export function writeToDiskSync(
  context: PrimaryStateWriteOperationsContext,
  opts: { expectedGeneration?: number } = {}
): boolean {
  const { runtime, serialization } = context
  if (runtime.fatalMutationError) {
    throw runtime.fatalMutationError
  }
  if (runtime.writesFrozen) {
    return false
  }
  const authority = runtime.profileStateAuthority
  if (!authority) {
    throw new Error('Writable Store construction requires a SQLite profile-state authority')
  }
  if (authority.asynchronous) {
    throw new Error('Live profile persistence requires an awaited flush')
  }
  const isCurrent =
    opts.expectedGeneration === undefined
      ? undefined
      : () => runtime.writeGeneration === opts.expectedGeneration
  const selective = writeSelectiveProfileState(
    authority,
    serialization,
    runtime.dirtyProfileStateDomains,
    runtime.pendingAutomationRunsAfter,
    isCurrent
  )
  if (selective.handled) {
    if (selective.aborted) {
      return false
    }
    if (selective.consumedAutomationRuns) {
      runtime.pendingAutomationRunsAfter = undefined
    }
    runtime.lastWrittenStateHash = null
    runtime.protectedSecrets.commitRetentionUpdates(selective.protectedSecretUpdates)
    markPrimaryStateWriteDurable(runtime, opts.expectedGeneration ?? runtime.writeGeneration)
    authority.scheduleBackup?.()
    return true
  }
  const built = serialization.buildStateToSave(
    authority.writeCompleteSerializedDomains !== undefined
  )
  const { stateHash, protectedSecretUpdates } = built
  if (isCurrent && !isCurrent()) {
    return false
  }
  // The authority fences the revision even when the complete state is unchanged.
  if (canReuseDurableProfileState(runtime, stateHash)) {
    runtime.dirtyProfileStateDomains = new Set()
    runtime.pendingAutomationRunsAfter = undefined
    markPrimaryStateWriteDurable(runtime, opts.expectedGeneration ?? runtime.writeGeneration)
    return true
  }
  if (built.domains && authority.writeCompleteSerializedDomains) {
    authority.writeCompleteSerializedDomains(built.domains)
  } else {
    authority.writeSerializedState(built.payload)
  }
  runtime.dirtyProfileStateDomains = new Set()
  runtime.pendingAutomationRunsAfter = undefined
  if (!isCurrent || isCurrent()) {
    runtime.lastWrittenStateHash = stateHash
    runtime.protectedSecrets.commitRetentionUpdates(protectedSecretUpdates)
  } else {
    runtime.lastWrittenStateHash = null
  }
  markPrimaryStateWriteDurable(runtime, opts.expectedGeneration ?? runtime.writeGeneration)
  authority.scheduleBackup?.()
  return true
}
