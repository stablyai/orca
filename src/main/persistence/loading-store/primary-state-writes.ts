import { unlinkSync } from 'node:fs'
import { mkdir, open, rm } from 'node:fs/promises'
import { durableWriteTempPath, renameDurable } from '../../durable-file-write'
import { dirname } from 'node:path'
import {
  parseCodexResetCreditAttemptLedger,
  type CodexResetCreditAttemptLedger
} from '../../../shared/codex-reset-credit-attempt-ledger'
import {
  canReuseDurableProfileState,
  markPrimaryStateWriteDurable,
  type PrimaryStateWriteOperationsRuntime
} from './primary-state-write-runtime'
import type { StateSerializationSecretHandlingOperations } from './state-serialization-secret-handling'
import type { BackupRecoveryRotationOperations } from './backup-recovery-rotation'
import type { PrimaryStateWriteOperationsContext } from './primary-state-write-context'
import { writeToDiskSync } from './primary-state-write-sync'

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
    if (runtime.quitFlushStarted) {
      throw new Error('Cannot synchronously flush after final persistence has started')
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
    this[primaryStateWriteOperationsContext].runtime.activeViewPreference.flushOrThrow()
  }

  getCodexResetCreditAttemptLedger(): CodexResetCreditAttemptLedger {
    return parseCodexResetCreditAttemptLedger(
      this[primaryStateWriteOperationsContext].runtime.state.codexResetCreditAttemptLedger
    )
  }

  replaceCodexResetCreditAttemptLedgerAndFlush(ledger: CodexResetCreditAttemptLedger): void {
    const { runtime } = this[primaryStateWriteOperationsContext]
    if (runtime.writesFrozen) {
      throw new Error('Cannot persist Codex reset-credit attempts while writes are frozen')
    }
    const next = parseCodexResetCreditAttemptLedger(ledger)
    const previous = runtime.state.codexResetCreditAttemptLedger
      ? structuredClone(runtime.state.codexResetCreditAttemptLedger)
      : undefined
    runtime.state.codexResetCreditAttemptLedger = next
    runtime.dirtyProfileStateDomains?.add('codexResetCreditAttemptLedger')
    try {
      runtime.flushOrThrow()
    } catch (error) {
      // Why: callers use a successful return as the durability barrier before
      // handing a scarce-credit mutation to the provider.
      runtime.state.codexResetCreditAttemptLedger = previous
      throw error
    }
  }
}

export function enqueueWrite(
  owner: PrimaryStateWriteOperations,
  options: { fullCheckpoint?: boolean } = {}
): Promise<void> {
  const { runtime } = owner[primaryStateWriteOperationsContext]
  const previousWrite = Promise.all([
    runtime.pendingWrite ?? runtime.staleTempCleanup,
    runtime.pendingSnapshotFileWork ?? Promise.resolve()
  ]).then(() => {})
  const write = previousWrite.then(() => {
    // A queued predecessor can clear dirty domains before this checkpoint runs.
    if (options.fullCheckpoint) {
      runtime.dirtyProfileStateDomains = null
    }
    return writeToDiskAsync(owner)
  })
  const trackedWrite = write
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

export async function writeToDiskAsync(owner: PrimaryStateWriteOperations): Promise<void> {
  const { runtime, serialization, backups } = owner[primaryStateWriteOperationsContext]
  if (runtime.writesFrozen) {
    return
  }
  const gen = runtime.writeGeneration
  if (runtime.profileStateAuthority) {
    // SQL commits are synchronous so both entry points share the same generation fence.
    writeToDiskSync(owner[primaryStateWriteOperationsContext], { expectedGeneration: gen })
    return
  }
  const built = serialization.buildStateToSave()
  const { stateHash, protectedSecretUpdates } = built
  // Why: don't rewrite a byte-identical multi-MB file when state nets out to already-persisted.
  if (canReuseDurableProfileState(runtime, stateHash)) {
    runtime.dirtyProfileStateDomains = new Set()
    runtime.pendingAutomationRunsAfter = undefined
    markPrimaryStateWriteDurable(runtime, gen)
    return
  }
  const dataFile = runtime.dataFile
  const payload = built.payload
  const dir = dirname(dataFile)
  await mkdir(dir, { recursive: true }).catch(() => {})
  const tmpFile = durableWriteTempPath(dataFile)

  // Why: on any write/rename failure, remove the tmp file so it doesn't leave a multi-MB orphan.
  let renamed = false
  try {
    // Why: fsync before rename, then fsync the directory; see writeFileDurable.
    const handle = await open(tmpFile, 'w')
    try {
      // Already UTF-8 bytes: passing the string here would re-encode the whole state on the main thread.
      await handle.writeFile(payload)
      await handle.sync()
    } finally {
      await handle.close()
    }
    // Why: if flush() bumped writeGeneration mid-write, it already wrote fresher state; don't overwrite it.
    if (runtime.writeGeneration !== gen) {
      return
    }
    runtime.inFlightAsyncTmpFile = tmpFile
    try {
      await renameDurable(tmpFile, dataFile)
      renamed = true
    } catch (error) {
      if (
        !(error instanceof Error && 'code' in error && error.code === 'ENOENT') ||
        runtime.writeGeneration === gen
      ) {
        throw error
      }
    } finally {
      if (runtime.inFlightAsyncTmpFile === tmpFile) {
        runtime.inFlightAsyncTmpFile = null
      }
    }
    // Why re-check gen: a mutation or sync flush during rename makes the installed hash ambiguous; invalidate the no-op guard.
    if (renamed && runtime.writeGeneration === gen) {
      runtime.lastWrittenStateHash = stateHash
      runtime.protectedSecrets.commitRetentionUpdates(protectedSecretUpdates)
    } else if (renamed) {
      runtime.lastWrittenStateHash = null
    }
    if (renamed) {
      runtime.dirtyProfileStateDomains = new Set()
      runtime.pendingAutomationRunsAfter = undefined
      markPrimaryStateWriteDurable(runtime, gen)
    }
  } finally {
    if (!renamed) {
      await rm(tmpFile).catch(() => {})
    }
  }
  if (!renamed) {
    return
  }
  // Why (#1158): rotate only after the primary rename while this write still owns its generation.
  if (runtime.writeGeneration !== gen) {
    return
  }
  await backups.rotateBackupsAsync(dataFile)
}

export function installPrimaryStateWriteOperationsContext(
  target: PrimaryStateWriteOperations,
  source: PrimaryStateWriteOperations
): void {
  Object.defineProperty(target, primaryStateWriteOperationsContext, {
    value: source[primaryStateWriteOperationsContext]
  })
}
