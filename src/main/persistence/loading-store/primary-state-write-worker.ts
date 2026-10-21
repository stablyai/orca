import type { AsyncProfileStateAuthority } from './profile-state-authority'
import type { PrimaryStateWriteOperationsContext } from './primary-state-write-context'
import { markPrimaryStateWriteDurable } from './primary-state-write-runtime'
import { prepareSelectiveProfileStateWrite } from './profile-state-selective-write'

/** The queued operation owns its captured intent; later edits belong to the next write. */
export async function writeProfileStateInWorker(
  { runtime, serialization }: PrimaryStateWriteOperationsContext,
  authority: AsyncProfileStateAuthority
): Promise<boolean> {
  authority.assertWritable()
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
    runtime.pendingAutomationRunsAfter ??= automationRuns
  }

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

/** Release copied payloads before the acknowledgement; retain only commit bookkeeping. */
function beginWrite(
  authority: AsyncProfileStateAuthority,
  serialization: PrimaryStateWriteOperationsContext['serialization'],
  dirtyDomains: ReadonlySet<string> | null,
  automationRuns: PrimaryStateWriteOperationsContext['runtime']['pendingAutomationRunsAfter'],
  lastWrittenStateHash: string | null,
  isCurrent: () => boolean
) {
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
    return { completion, stateHash: null, protectedSecretUpdates: selective.protectedSecretUpdates }
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
    protectedSecretUpdates: unchanged ? [] : complete.protectedSecretUpdates
  }
}
