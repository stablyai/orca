import { mkdirSync, existsSync, unlinkSync } from 'node:fs'
import { mkdir, open, rm } from 'node:fs/promises'
import { durableWriteTempPath, renameDurable, writeFileDurableSync } from '../../durable-file-write'
import { dirname } from 'node:path'
import {
  parseCodexResetCreditAttemptLedger,
  type CodexResetCreditAttemptLedger
} from '../../../shared/codex-reset-credit-attempt-ledger'

import type { StoreRuntimeState } from './store-runtime-state'
import type { StateSerializationSecretHandlingOperations } from './state-serialization-secret-handling'
import type { BackupRecoveryRotationOperations } from './backup-recovery-rotation'

type PrimaryStateWriteOperationsRuntime = Pick<
  StoreRuntimeState,
  | 'activeViewPreference'
  | 'backupRotationInFlight'
  | 'dataFile'
  | 'flushOrThrow'
  | 'firstPendingSaveAt'
  | 'inFlightAsyncTmpFile'
  | 'lastDurableWriteGeneration'
  | 'lastWrittenStateHash'
  | 'pendingSnapshotFileWork'
  | 'pendingWrite'
  | 'protectedSecrets'
  | 'quitFlushStarted'
  | 'staleTempCleanup'
  | 'state'
  | 'writeGeneration'
  | 'writeTimer'
  | 'writesFrozen'
>

const primaryStateWriteOperationsContext = Symbol('PrimaryStateWriteOperations')
type PrimaryStateWriteOperationsContext = {
  runtime: PrimaryStateWriteOperationsRuntime
  serialization: StateSerializationSecretHandlingOperations
  backups: BackupRecoveryRotationOperations
}

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
    if (this[primaryStateWriteOperationsContext].runtime.quitFlushStarted) {
      throw new Error('Cannot synchronously flush after final persistence has started')
    }
    if (this[primaryStateWriteOperationsContext].runtime.writeTimer) {
      clearTimeout(this[primaryStateWriteOperationsContext].runtime.writeTimer)
      this[primaryStateWriteOperationsContext].runtime.writeTimer = null
    }
    this[primaryStateWriteOperationsContext].runtime.firstPendingSaveAt = null
    const asyncWriteWasInFlight =
      this[primaryStateWriteOperationsContext].runtime.pendingWrite !== null
    // Why: bump writeGeneration so an in-flight async write skips its rename and can't overwrite this sync write.
    this[primaryStateWriteOperationsContext].runtime.writeGeneration++
    if (this[primaryStateWriteOperationsContext].runtime.inFlightAsyncTmpFile) {
      try {
        unlinkSync(this[primaryStateWriteOperationsContext].runtime.inFlightAsyncTmpFile)
        this[primaryStateWriteOperationsContext].runtime.inFlightAsyncTmpFile = null
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          void enqueueWrite(this).catch(() => {})
          throw error
        }
      }
    }
    // Why: later async flushes must remain serialized behind the invalidated writer.
    writeToDiskSync(this, {
      force: asyncWriteWasInFlight,
      skipBackupRotation: this[primaryStateWriteOperationsContext].runtime.backupRotationInFlight
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
    if (this[primaryStateWriteOperationsContext].runtime.writesFrozen) {
      throw new Error('Cannot persist Codex reset-credit attempts while writes are frozen')
    }
    const next = parseCodexResetCreditAttemptLedger(ledger)
    const previous = this[primaryStateWriteOperationsContext].runtime.state
      .codexResetCreditAttemptLedger
      ? structuredClone(
          this[primaryStateWriteOperationsContext].runtime.state.codexResetCreditAttemptLedger
        )
      : undefined
    this[primaryStateWriteOperationsContext].runtime.state.codexResetCreditAttemptLedger = next
    try {
      this[primaryStateWriteOperationsContext].runtime.flushOrThrow()
    } catch (error) {
      // Why: callers use a successful return as the durability barrier before
      // handing a scarce-credit mutation to the provider.
      this[primaryStateWriteOperationsContext].runtime.state.codexResetCreditAttemptLedger =
        previous
      throw error
    }
  }
}

export function enqueueWrite(owner: PrimaryStateWriteOperations): Promise<void> {
  const previousWrite = Promise.all([
    owner[primaryStateWriteOperationsContext].runtime.pendingWrite ??
      owner[primaryStateWriteOperationsContext].runtime.staleTempCleanup,
    owner[primaryStateWriteOperationsContext].runtime.pendingSnapshotFileWork ?? Promise.resolve()
  ]).then(() => {})
  const write = previousWrite.then(() => writeToDiskAsync(owner))
  const trackedWrite = write
    .catch((err) => {
      console.error('[persistence] Failed to write state:', err)
    })
    .finally(() => {
      if (owner[primaryStateWriteOperationsContext].runtime.pendingWrite === trackedWrite) {
        owner[primaryStateWriteOperationsContext].runtime.pendingWrite = null
      }
    })
  owner[primaryStateWriteOperationsContext].runtime.pendingWrite = trackedWrite
  return write
}

export async function writeToDiskAsync(owner: PrimaryStateWriteOperations): Promise<void> {
  if (owner[primaryStateWriteOperationsContext].runtime.writesFrozen) {
    return
  }
  const gen = owner[primaryStateWriteOperationsContext].runtime.writeGeneration
  const { payload, stateHash, protectedSecretUpdates } =
    owner[primaryStateWriteOperationsContext].serialization.buildStateToSave()
  // Why: don't rewrite a byte-identical multi-MB file when state nets out to already-persisted.
  if (stateHash === owner[primaryStateWriteOperationsContext].runtime.lastWrittenStateHash) {
    owner[primaryStateWriteOperationsContext].runtime.lastDurableWriteGeneration = Math.max(
      owner[primaryStateWriteOperationsContext].runtime.lastDurableWriteGeneration,
      gen
    )
    return
  }
  const dataFile = owner[primaryStateWriteOperationsContext].runtime.dataFile
  const dir = dirname(dataFile)
  await mkdir(dir, { recursive: true }).catch(() => {})
  const tmpFile = durableWriteTempPath(dataFile)

  // Why: on any write/rename failure, remove the tmp file so it doesn't leave a multi-MB orphan.
  let renamed = false
  try {
    // Why: fsync before rename, then fsync the directory; see writeFileDurable.
    const handle = await open(tmpFile, 'w')
    try {
      await handle.writeFile(payload, 'utf-8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    // Why: if flush() bumped writeGeneration mid-write, it already wrote fresher state; don't overwrite it.
    if (owner[primaryStateWriteOperationsContext].runtime.writeGeneration !== gen) {
      return
    }
    owner[primaryStateWriteOperationsContext].runtime.inFlightAsyncTmpFile = tmpFile
    try {
      await renameDurable(tmpFile, dataFile)
      renamed = true
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== 'ENOENT' ||
        owner[primaryStateWriteOperationsContext].runtime.writeGeneration === gen
      ) {
        throw error
      }
    } finally {
      if (owner[primaryStateWriteOperationsContext].runtime.inFlightAsyncTmpFile === tmpFile) {
        owner[primaryStateWriteOperationsContext].runtime.inFlightAsyncTmpFile = null
      }
    }
    // Why re-check gen: a mutation or sync flush during rename makes the installed hash ambiguous; invalidate the no-op guard.
    if (renamed && owner[primaryStateWriteOperationsContext].runtime.writeGeneration === gen) {
      owner[primaryStateWriteOperationsContext].runtime.lastWrittenStateHash = stateHash
      owner[primaryStateWriteOperationsContext].runtime.protectedSecrets.commitRetentionUpdates(
        protectedSecretUpdates
      )
    } else if (renamed) {
      owner[primaryStateWriteOperationsContext].runtime.lastWrittenStateHash = null
    }
    if (renamed) {
      owner[primaryStateWriteOperationsContext].runtime.lastDurableWriteGeneration = Math.max(
        owner[primaryStateWriteOperationsContext].runtime.lastDurableWriteGeneration,
        gen
      )
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
  if (owner[primaryStateWriteOperationsContext].runtime.writeGeneration !== gen) {
    return
  }
  await owner[primaryStateWriteOperationsContext].backups.rotateBackupsAsync(dataFile)
}

export function writeToDiskSync(
  owner: PrimaryStateWriteOperations,
  opts: { force?: boolean; skipBackupRotation?: boolean } = {}
): void {
  if (owner[primaryStateWriteOperationsContext].runtime.writesFrozen) {
    return
  }
  const { payload, stateHash, protectedSecretUpdates } =
    owner[primaryStateWriteOperationsContext].serialization.buildStateToSave()
  // Why: matching hash means the file already holds this state; force overrides when an async rename may be racing past the gen check.
  if (
    !opts.force &&
    stateHash === owner[primaryStateWriteOperationsContext].runtime.lastWrittenStateHash
  ) {
    return
  }
  const dataFile = owner[primaryStateWriteOperationsContext].runtime.dataFile
  const dir = dirname(dataFile)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  const tmpFile = `${dataFile}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`

  // Why: on any write/rename failure, remove the tmp file so shutdown crashes don't leak orphans.
  let renamed = false
  try {
    // Why: fsync the temp file and the directory; a bare rename can survive as stale or empty
    // content after power loss, losing projects/tabs back to the newest usable .bak slot.
    writeFileDurableSync(tmpFile, dataFile, payload)
    renamed = true
    owner[primaryStateWriteOperationsContext].runtime.lastWrittenStateHash = stateHash
    owner[primaryStateWriteOperationsContext].runtime.protectedSecrets.commitRetentionUpdates(
      protectedSecretUpdates
    )
    owner[primaryStateWriteOperationsContext].runtime.lastDurableWriteGeneration = Math.max(
      owner[primaryStateWriteOperationsContext].runtime.lastDurableWriteGeneration,
      owner[primaryStateWriteOperationsContext].runtime.writeGeneration
    )
  } finally {
    if (!renamed) {
      try {
        unlinkSync(tmpFile)
      } catch {
        // Best-effort cleanup; the write already failed, swallow secondary error.
      }
    }
  }
  const now = Date.now()
  if (
    !opts.skipBackupRotation &&
    owner[primaryStateWriteOperationsContext].backups.shouldRotateBackups(now, dataFile)
  ) {
    owner[primaryStateWriteOperationsContext].backups.rotateBackupsSync(dataFile)
  }
}

export function installPrimaryStateWriteOperationsContext(
  target: object,
  source: PrimaryStateWriteOperations
): void {
  Object.defineProperty(target, primaryStateWriteOperationsContext, {
    value: source[primaryStateWriteOperationsContext]
  })
}
