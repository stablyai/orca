import { unlinkSync } from 'node:fs'
import {
  parseCodexResetCreditAttemptLedger,
  type CodexResetCreditAttemptLedger
} from '../../../shared/codex-reset-credit-attempt-ledger'
import {
  stopAfterFailedPrimaryStateMutation,
  type PrimaryStateWriteOperationsRuntime
} from './primary-state-write-runtime'
import type { StateSerializationSecretHandlingOperations } from './state-serialization-secret-handling'
import type { BackupRecoveryRotationOperations } from './backup-recovery-rotation'
import type { PrimaryStateWriteOperationsContext } from './primary-state-write-context'
import { writeToDiskSync } from './primary-state-write-sync'
import { writeProfileStateInWorker } from './primary-state-write-worker'
import { writeJsonProfileState } from './primary-state-write-json'
import type { DurableProfileStateMutation } from './store-runtime-state'
import { profileStateWriterFailureOutcome } from '../profile-state/profile-state-writer-errors'

const primaryStateWriteOperationsContext = Symbol('PrimaryStateWriteOperations')
export class PrimaryStateWriteOperations {
  readonly [primaryStateWriteOperationsContext]: PrimaryStateWriteOperationsContext

  constructor(
    runtime: PrimaryStateWriteOperationsRuntime,
    serialization: StateSerializationSecretHandlingOperations,
    backups: BackupRecoveryRotationOperations
  ) {
    this[primaryStateWriteOperationsContext] = { runtime, serialization, backups }
  }

  flushOrThrow(): void {
    const context = this[primaryStateWriteOperationsContext]
    const { runtime } = context
    if (runtime.quitFlushStarted || runtime.profileMaintenancePending) {
      throw new Error('Cannot synchronously flush after final persistence has started')
    }
    if (runtime.profileStateAuthority?.asynchronous) {
      throw new Error('Live profile persistence requires an awaited flush')
    }
    if (runtime.writeTimer) {
      clearTimeout(runtime.writeTimer)
      runtime.writeTimer = null
    }
    runtime.firstPendingSaveAt = null
    const asyncWriteWasInFlight = runtime.pendingWrite !== null
    // Why: bump writeGeneration so an in-flight async write skips its rename and can't overwrite this sync write.
    runtime.writeGeneration++
    if (runtime.inFlightAsyncTmpFile) {
      try {
        unlinkSync(runtime.inFlightAsyncTmpFile)
        runtime.inFlightAsyncTmpFile = null
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
          void enqueueWrite(this).catch(() => {})
          throw error
        }
      }
    }
    // Why: later async flushes must remain serialized behind the invalidated writer.
    writeToDiskSync(context, {
      force: asyncWriteWasInFlight,
      skipBackupRotation: runtime.backupRotationInFlight
    })
  }

  flushActiveViewPreferenceOrThrow(): void {
    if (this[primaryStateWriteOperationsContext].runtime.profileMaintenancePending) {
      throw new Error('Cannot flush active-view persistence during profile maintenance')
    }
    this[primaryStateWriteOperationsContext].runtime.activeViewPreference.flushOrThrow()
  }

  /** Expected refusals return persist: false; thrown callbacks stop saving to protect partial state. */
  runDurableMutation<T>(mutate: () => DurableProfileStateMutation<T>): Promise<T> {
    const { runtime } = this[primaryStateWriteOperationsContext]
    if (runtime.writesFrozen || runtime.quitFlushStarted || runtime.profileMaintenancePending) {
      return Promise.reject(new Error('Cannot mutate finalized profile persistence'))
    }
    return enqueuePrimaryStateOperation(this, async () => {
      if (runtime.profileStateAuthority?.asynchronous) {
        runtime.profileStateAuthority.assertWritable()
      }
      let mutation: DurableProfileStateMutation<T>
      try {
        mutation = this.runAdmittedMutationCallback('mutate', mutate)
      } catch (error) {
        await stopAfterFailedPrimaryStateMutation(runtime, error)
        throw error
      }
      if (
        mutation.persist === false ||
        (mutation.persist === 'if-dirty' &&
          runtime.lastDurableWriteGeneration >= runtime.writeGeneration)
      ) {
        return mutation.value
      }
      runtime.writeGeneration++
      const requiredGeneration = runtime.writeGeneration
      try {
        const captured = runtime.profileStateAuthority?.asynchronous
          ? await writeToDiskAsync(this)
          : writeToDiskSync(this[primaryStateWriteOperationsContext], {
              expectedGeneration: requiredGeneration
            })
        if (!captured || runtime.lastDurableWriteGeneration < requiredGeneration) {
          throw new Error('Profile mutation changed while preparing its durable snapshot')
        }
      } catch (error) {
        if (profileStateWriterFailureOutcome(error) !== 'indeterminate') {
          if (mutation.rollback) {
            try {
              this.runAdmittedMutationCallback('rollback', mutation.rollback)
            } catch (rollbackError) {
              await stopAfterFailedPrimaryStateMutation(runtime, rollbackError)
              throw rollbackError
            }
          }
        }
        throw error
      }
      return mutation.value
    })
  }

  private runAdmittedMutationCallback<T>(phase: 'mutate' | 'rollback', callback: () => T): T {
    const { runtime } = this[primaryStateWriteOperationsContext]
    // Finalization drains admitted mutations; the disk wait must not admit new snapshots.
    runtime.durableMutationPhase = phase
    try {
      return callback()
    } finally {
      runtime.durableMutationPhase = null
    }
  }

  getCodexResetCreditAttemptLedger(): CodexResetCreditAttemptLedger {
    return parseCodexResetCreditAttemptLedger(
      this[primaryStateWriteOperationsContext].runtime.state.codexResetCreditAttemptLedger
    )
  }

  replaceCodexResetCreditAttemptLedgerAndFlush(
    ledger: CodexResetCreditAttemptLedger
  ): Promise<void> {
    const { runtime } = this[primaryStateWriteOperationsContext]
    const next = parseCodexResetCreditAttemptLedger(ledger)
    return this.runDurableMutation(() => {
      const previous = runtime.state.codexResetCreditAttemptLedger
      runtime.state.codexResetCreditAttemptLedger = next
      runtime.dirtyProfileStateDomains?.add('codexResetCreditAttemptLedger')
      return {
        value: undefined,
        rollback: () => {
          if (runtime.state.codexResetCreditAttemptLedger === next) {
            runtime.state.codexResetCreditAttemptLedger = previous
          }
        }
      }
    })
  }
}

export function enqueueWrite(
  owner: PrimaryStateWriteOperations,
  options: { fullCheckpoint?: boolean; skipIfClean?: boolean; signal?: AbortSignal } = {}
): Promise<void> {
  const context = owner[primaryStateWriteOperationsContext]
  const { runtime } = context
  const batchable =
    runtime.profileStateAuthority?.asynchronous && !options.fullCheckpoint && !options.signal
  const queued = context.queuedSnapshot
  if (batchable && queued) {
    queued.capture.skipIfClean &&= options.skipIfClean === true
    // Merged explicit flushes must retain the full capture that covered untracked getter edits.
    queued.capture.fullCheckpoint ||= !queued.capture.skipIfClean
    queued.capture.pendingSnapshotFileWork = runtime.pendingSnapshotFileWork
    return queued.completion
  }
  const capture = {
    skipIfClean: options.skipIfClean === true,
    fullCheckpoint: options.fullCheckpoint === true,
    pendingSnapshotFileWork: runtime.pendingSnapshotFileWork
  }
  const completion = enqueuePrimaryStateOperation(owner, async () => {
    // Later flushes must capture edits made after this batch starts, even without a new generation.
    if (context.queuedSnapshot?.capture === capture) {
      context.queuedSnapshot = undefined
    }
    if (batchable) {
      await capture.pendingSnapshotFileWork
    }
    const { signal } = options
    if (signal?.aborted) {
      throw new Error('Persistence flush aborted')
    }
    if (
      capture.skipIfClean &&
      runtime.dirtyProfileStateDomains?.size === 0 &&
      runtime.pendingAutomationRunsAfter === undefined &&
      runtime.lastDurableWriteGeneration >= runtime.writeGeneration
    ) {
      return
    }
    // A queued predecessor can clear dirty domains before this checkpoint runs.
    if (capture.fullCheckpoint) {
      runtime.dirtyProfileStateDomains = null
    }
    const authority = runtime.profileStateAuthority
    const abort = () => {
      if (authority?.asynchronous) {
        void authority
          .abort()
          .catch((error) =>
            console.error('[persistence] Failed to stop aborted profile writer:', error)
          )
      }
    }
    signal?.addEventListener('abort', abort, { once: true })
    try {
      await writeToDiskAsync(owner)
    } finally {
      signal?.removeEventListener('abort', abort)
    }
  })
  if (batchable) {
    context.queuedSnapshot = { completion, capture }
  }
  return completion
}

export function enqueuePrimaryStateOperation<T>(
  owner: PrimaryStateWriteOperations,
  operation: () => Promise<T>
): Promise<T> {
  const context = owner[primaryStateWriteOperationsContext]
  const { runtime } = context
  // A durable mutation, export, or independent checkpoint separates adjacent snapshot batches.
  context.queuedSnapshot = undefined
  const previousWrite = Promise.all([
    runtime.pendingWrite ?? runtime.staleTempCleanup,
    runtime.pendingSnapshotFileWork ?? Promise.resolve()
  ]).then(() => {})
  const write = previousWrite.then(operation).finally(() => {
    if (context.queuedSnapshot?.completion === write) {
      context.queuedSnapshot = undefined
    }
  })
  const trackedWrite = write
    .then(() => {})
    .catch((err) => {
      console.error('[persistence] Failed to write state:', err)
    })
    .finally(() => {
      if (runtime.pendingWrite === trackedWrite) {
        runtime.pendingWrite = null
      }
    })
  runtime.pendingWrite = trackedWrite
  return write
}

export async function writeToDiskAsync(owner: PrimaryStateWriteOperations): Promise<boolean> {
  const { runtime } = owner[primaryStateWriteOperationsContext]
  if (runtime.fatalMutationError) {
    throw runtime.fatalMutationError
  }
  if (runtime.writesFrozen) {
    return false
  }
  const gen = runtime.writeGeneration
  if (runtime.profileStateAuthority?.asynchronous) {
    return writeProfileStateInWorker(
      owner[primaryStateWriteOperationsContext],
      runtime.profileStateAuthority
    )
  }
  if (runtime.profileStateAuthority) {
    // SQL commits are synchronous so both entry points share the same generation fence.
    return writeToDiskSync(owner[primaryStateWriteOperationsContext], { expectedGeneration: gen })
  }
  return writeJsonProfileState(owner[primaryStateWriteOperationsContext], gen)
}

export function installPrimaryStateWriteOperationsContext(
  target: PrimaryStateWriteOperations,
  source: PrimaryStateWriteOperations
): void {
  Object.defineProperty(target, primaryStateWriteOperationsContext, {
    value: source[primaryStateWriteOperationsContext]
  })
}
