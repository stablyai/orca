import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { durableWriteTempPath, writeFileDurableSync } from '../../durable-file-write'
import { writeSelectiveProfileState } from './profile-state-selective-write'
import type { PrimaryStateWriteOperationsContext } from './primary-state-write-context'
import {
  canReuseDurableProfileState,
  markPrimaryStateWriteDurable
} from './primary-state-write-runtime'

export function writeToDiskSync(
  context: PrimaryStateWriteOperationsContext,
  opts: { force?: boolean; skipBackupRotation?: boolean; expectedGeneration?: number } = {}
): void {
  const { runtime, serialization, backups } = context
  if (runtime.writesFrozen) {
    return
  }
  const isCurrent =
    opts.expectedGeneration === undefined
      ? undefined
      : () => runtime.writeGeneration === opts.expectedGeneration
  const selective = writeSelectiveProfileState(
    runtime.profileStateAuthority,
    serialization,
    runtime.dirtyProfileStateDomains,
    runtime.pendingAutomationRunsAfter,
    isCurrent
  )
  if (selective.handled) {
    if (selective.aborted) {
      return
    }
    if (selective.consumedAutomationRuns) {
      runtime.pendingAutomationRunsAfter = undefined
    }
    runtime.lastWrittenStateHash = null
    runtime.protectedSecrets.commitRetentionUpdates(selective.protectedSecretUpdates)
    markPrimaryStateWriteDurable(runtime, opts.expectedGeneration ?? runtime.writeGeneration)
    runtime.profileStateAuthority?.scheduleBackup?.()
    return
  }
  const built = serialization.buildStateToSave(
    runtime.profileStateAuthority?.writeCompleteSerializedDomains !== undefined
  )
  const { stateHash, protectedSecretUpdates } = built
  // Why: matching hash means the file already holds this state; force overrides an async rename race.
  if (!opts.force && canReuseDurableProfileState(runtime, stateHash)) {
    runtime.dirtyProfileStateDomains = new Set()
    runtime.pendingAutomationRunsAfter = undefined
    markPrimaryStateWriteDurable(runtime, opts.expectedGeneration ?? runtime.writeGeneration)
    return
  }
  if (runtime.profileStateAuthority) {
    if (isCurrent && !isCurrent()) {
      return
    }
    if (built.domains && runtime.profileStateAuthority.writeCompleteSerializedDomains) {
      runtime.profileStateAuthority.writeCompleteSerializedDomains(built.domains)
    } else {
      runtime.profileStateAuthority.writeSerializedState(built.payload)
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
    runtime.profileStateAuthority.scheduleBackup?.()
    return
  }
  const dataFile = runtime.dataFile
  const payload = built.payload
  const dir = dirname(dataFile)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileDurableSync(durableWriteTempPath(dataFile), dataFile, payload)
  runtime.dirtyProfileStateDomains = new Set()
  runtime.lastWrittenStateHash = stateHash
  runtime.pendingAutomationRunsAfter = undefined
  runtime.protectedSecrets.commitRetentionUpdates(protectedSecretUpdates)
  markPrimaryStateWriteDurable(runtime, opts.expectedGeneration ?? runtime.writeGeneration)
  const now = Date.now()
  if (!opts.skipBackupRotation && backups.shouldRotateBackups(now, dataFile)) {
    backups.rotateBackupsSync(dataFile)
  }
}
