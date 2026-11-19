import type { AsyncProfileStateAuthority } from './profile-state-authority'
import type { PrimaryStateWriteOperationsContext } from './primary-state-write-context'
import { markPrimaryStateWriteDurable } from './primary-state-write-runtime'
import { prepareSelectiveProfileStateWrite } from './profile-state-selective-write'

// Capture intent now; edits made while this operation waits belong to the next write.
export async function writeProfileStateInWorker(
  { runtime, serialization }: PrimaryStateWriteOperationsContext,
  authority: AsyncProfileStateAuthority,
  wholeSessions = false
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

  try {
    const prepared = beginWrite(
      authority,
      serialization,
      dirtyDomains,
      automationRuns,
      runtime.lastWrittenStateHash,
      () => runtime.writeGeneration === generation,
      wholeSessions
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
    // A failed or indeterminate write leaves the writer's session copy unknown.
    serialization.sessionSaveBaseline.clear()
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
  isCurrent: () => boolean,
  wholeSessions: boolean
) {
  const baseline = serialization.sessionSaveBaseline
  const selective = prepareSelectiveProfileStateWrite(
    authority,
    serialization,
    dirtyDomains,
    automationRuns,
    true
  )
  if (selective) {
    if (!isCurrent()) {
      return undefined
    }
    const { replacements, patches, sessionCandidates } = selective
    const written =
      selective.automationRuns !== undefined
        ? authority.writeSerializedAutomationRuns(replacements, selective.automationRuns)
        : replacements.length === 0 && patches.length === 0 && sessionCandidates.length > 0
          ? // The dirty session domains match what the writer holds; still fence the revision.
            authority.assertCurrentRevision()
          : authority.writeSerializedDomains(replacements, patches)
    return {
      completion: written.then(() => baseline.acknowledge(sessionCandidates)),
      stateHash: null,
      protectedSecretUpdates: selective.protectedSecretUpdates
    }
  }
  // Session domains the writer holds travel as changed entries unless a deep capture is required.
  const complete = serialization.buildStateToSave(true, wholeSessions ? 'whole' : 'patch')
  if (!isCurrent()) {
    return undefined
  }
  if (!complete.domains) {
    // A whole-document payload replaces the session without recording the writer's copy.
    baseline.clear()
  }
  const { patches = [], sessionCandidates = [] } = complete
  const unchanged =
    complete.stateHash === lastWrittenStateHash &&
    patches.every(({ operations }) => operations.length === 0)
  const written = unchanged
    ? authority.assertCurrentRevision()
    : complete.domains
      ? authority.writeCompleteSerializedDomains(complete.domains, patches)
      : authority.writeSerializedState(complete.payload)
  return {
    completion: written.then(() => baseline.acknowledge(sessionCandidates)),
    stateHash: complete.stateHash,
    protectedSecretUpdates: unchanged ? [] : complete.protectedSecretUpdates
  }
}
