import { ProfileStateSaveIntent } from './profile-state-save-intent'
import { writeSelectiveProfileState } from './profile-state-selective-write'
import { profileStateWriterFailureOutcome } from '../../profile-state/writer/profile-state-writer-errors'
import type { PrimaryStateWriteOperationsContext } from './primary-state-write-context'
import {
  canReuseDurableProfileState,
  capturePrimaryStateWriteIntent,
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
  if (authority.writePreparedState) {
    const intent = capturePrimaryStateWriteIntent(runtime)
    try {
      const captured = serialization.buildPreparedStateWrite(
        intent.dirtyDomains,
        intent.automationRuns
      )
      if (isCurrent && !isCurrent()) {
        intent.restoreIntent()
        return false
      }
      if (
        !captured.bypassEquality &&
        captured.stateHash !== null &&
        canReuseDurableProfileState(runtime, captured.stateHash)
      ) {
        captured.acknowledge()
      } else {
        if (captured.write) {
          authority.writePreparedState(captured.write)
        } else if (captured.domains && authority.writeCompleteSerializedDomains) {
          authority.writeCompleteSerializedDomains(captured.domains)
        } else {
          authority.writeSerializedState(captured.payload)
        }
        captured.acknowledge()
        runtime.protectedSecrets.commitRetentionUpdates(captured.protectedSecretUpdates)
      }
      runtime.lastWrittenStateHash =
        runtime.writeGeneration === intent.generation ? captured.stateHash : null
      markPrimaryStateWriteDurable(runtime, intent.generation)
    } catch (error) {
      if (profileStateWriterFailureOutcome(error) === 'indeterminate') {
        runtime.workspaceSessionFieldCapture.clear()
      }
      intent.restoreIntent()
      throw error
    }
    try {
      authority.scheduleBackup?.()
    } catch (error) {
      console.error('[persistence] Failed to schedule profile state backup:', error)
    }
    return true
  }
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
    runtime.dirtyProfileStateDomains = new ProfileStateSaveIntent()
    runtime.pendingAutomationRunsAfter = undefined
    markPrimaryStateWriteDurable(runtime, opts.expectedGeneration ?? runtime.writeGeneration)
    return true
  }
  if (built.domains && authority.writeCompleteSerializedDomains) {
    authority.writeCompleteSerializedDomains(built.domains)
  } else {
    authority.writeSerializedState(built.payload)
  }
  runtime.dirtyProfileStateDomains = new ProfileStateSaveIntent()
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
