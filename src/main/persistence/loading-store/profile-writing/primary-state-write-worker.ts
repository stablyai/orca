import type { AsyncProfileStateAuthority } from './profile-state-authority'
import type { PrimaryStateWriteOperationsContext } from './primary-state-write-context'
import {
  capturePrimaryStateWriteIntent,
  markPrimaryStateWriteDurable
} from './primary-state-write-runtime'
import { profileStateWriterFailureOutcome } from '../../profile-state/writer/profile-state-writer-errors'
import { prepareSelectiveProfileStateWrite } from './profile-state-selective-write'

// Capture intent now; edits made while this operation waits belong to the next write.
export async function writeProfileStateInWorker(
  { runtime, serialization }: PrimaryStateWriteOperationsContext,
  authority: AsyncProfileStateAuthority
): Promise<boolean> {
  authority.assertWritable()
  const { generation, dirtyDomains, automationRuns, restoreIntent } =
    capturePrimaryStateWriteIntent(runtime)

  try {
    const prepared = beginWrite(
      authority,
      serialization,
      dirtyDomains,
      automationRuns,
      runtime.lastWrittenStateHash,
      () => runtime.writeGeneration === generation
    )
    if (!prepared) {
      restoreIntent()
      return false
    }
    await prepared.completion
    prepared.acknowledge?.()
    runtime.protectedSecrets.commitRetentionUpdates(prepared.protectedSecretUpdates)
    runtime.lastWrittenStateHash =
      runtime.writeGeneration === generation ? prepared.stateHash : null
    markPrimaryStateWriteDurable(runtime, generation)
    if (runtime.writeGeneration === generation) {
      if (runtime.writeTimer) {
        clearTimeout(runtime.writeTimer)
        runtime.writeTimer = null
      }
      runtime.firstPendingSaveAt = null
    }
  } catch (error) {
    if (profileStateWriterFailureOutcome(error) === 'indeterminate') {
      runtime.profileStateSplitSnapshots.clear()
    }
    restoreIntent()
    throw error
  }
  try {
    authority.scheduleBackup?.()
  } catch (error) {
    console.error('[persistence] Failed to schedule profile state backup:', error)
  }
  return true
}

/** Drop copied payloads before acknowledgement; retain commit bookkeeping only. */
function beginWrite(
  authority: AsyncProfileStateAuthority,
  serialization: PrimaryStateWriteOperationsContext['serialization'],
  dirtyDomains: ReadonlySet<string> | null,
  automationRuns: PrimaryStateWriteOperationsContext['runtime']['pendingAutomationRunsAfter'],
  lastWrittenStateHash: string | null,
  isCurrent: () => boolean
) {
  if (authority.writePreparedState) {
    const captured = serialization.buildPreparedStateWrite(dirtyDomains, automationRuns)
    if (!isCurrent()) {
      return undefined
    }
    const unchanged = captured.stateHash !== null && captured.stateHash === lastWrittenStateHash
    const completion = unchanged
      ? authority.assertCurrentRevision()
      : captured.write
        ? authority.writePreparedState(captured.write)
        : authority.writeSerializedState(captured.payload)
    return {
      completion,
      stateHash: captured.stateHash,
      protectedSecretUpdates: unchanged ? [] : captured.protectedSecretUpdates,
      acknowledge: captured.acknowledge
    }
  }
  const selective = prepareSelectiveProfileStateWrite(
    authority,
    serialization,
    dirtyDomains,
    automationRuns
  )
  if (selective) {
    if (!isCurrent()) {
      return undefined
    }
    const completion =
      selective.automationRuns !== undefined
        ? authority.writeSerializedAutomationRuns(selective.replacements, selective.automationRuns)
        : authority.writeSerializedDomains(selective.replacements)
    return {
      completion,
      stateHash: null,
      protectedSecretUpdates: selective.protectedSecretUpdates,
      acknowledge: undefined
    }
  }
  const complete = serialization.buildStateToSave(true)
  if (!isCurrent()) {
    return undefined
  }
  const unchanged = complete.stateHash === lastWrittenStateHash
  const completion = unchanged
    ? authority.assertCurrentRevision()
    : complete.domains
      ? authority.writeCompleteSerializedDomains(complete.domains)
      : authority.writeSerializedState(complete.payload)
  return {
    completion,
    stateHash: complete.stateHash,
    protectedSecretUpdates: unchanged ? [] : complete.protectedSecretUpdates,
    acknowledge: undefined
  }
}
