// Recovery-point inventory and atomic restore for migration backups (runbook:
// "General Data recovery UI"). Only metadata crosses to the renderer — never a
// filesystem path or raw backup contents; restore/retry are main-owned.

import { existsSync, readFileSync, renameSync, statSync } from 'node:fs'
import {
  classifyPinnedPreV1Backup,
  pinnedPreV1BackupPath
} from '../agent-launch/agent-catalog-pre-v1-backup'
import { durableWriteTempPath, writeFileDurableSync } from '../durable-file-write'
import type { RecoveryPointDto, RecoveryPointId } from '../../shared/data-recovery'

export type { RecoveryPointDto, RecoveryPointId } from '../../shared/data-recovery'

export const PRE_RESTORE_SAFETY_SUFFIX = '.pre-restore-safety.backup'
export const RETIRED_BACKUP_SUFFIX = '.pre-downgrade'

type RestoreStore = {
  getDataFilePath(): string
  getBackupRingFilePaths(): string[]
  freezeWrites(): void
  unfreezeWrites(): void
  waitForPendingWrite(): Promise<void>
}

function recoveryPointPath(dataFile: string, id: RecoveryPointId): string {
  switch (id) {
    case 'agent-catalog-pre-v1':
      return pinnedPreV1BackupPath(dataFile)
  }
}

export function listRecoveryPoints(dataFile: string): RecoveryPointDto[] {
  const points: RecoveryPointDto[] = []
  const pinned = pinnedPreV1BackupPath(dataFile)
  if (existsSync(pinned)) {
    let createdAtMs: number | null = null
    let sizeBytes: number | null = null
    try {
      const stat = statSync(pinned)
      createdAtMs = stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs
      sizeBytes = stat.size
    } catch {
      // Metadata is best-effort; readability is decided below, not here.
    }
    points.push({
      id: 'agent-catalog-pre-v1',
      compatibility: 'previous-binary',
      createdAtMs,
      sizeBytes,
      // Existence alone would advertise a rollback nobody can actually read.
      restorable: classifyPinnedPreV1Backup(pinned).state === 'usable'
    })
  }
  return points
}

/** Moves the rotating `.bak.N` slots out of the names the loader scans. They hold
 *  snapshots this binary wrote, and the load-time fallback restores any slot that
 *  merely parses — so on the older binary the ring would silently resurrect the
 *  very state the downgrade discarded. Renamed rather than deleted so the bytes
 *  stay recoverable by hand, and best-effort so a locked slot (Windows) cannot
 *  fail a restore that already committed. */
function retireBackupRing(store: RestoreStore): void {
  for (const slot of store.getBackupRingFilePaths()) {
    if (!existsSync(slot)) {
      continue
    }
    try {
      renameSync(slot, `${slot}${RETIRED_BACKUP_SUFFIX}`)
    } catch (error) {
      console.error(`Could not retire backup slot ${slot}:`, error)
    }
  }
}

export type RestoreRecoveryPointResult = { ok: true } | { ok: false; error: string }

/** Validates the selected backup, suspends writes, keeps a pre-restore safety
 *  copy, and atomically replaces the live data file. Failure or invalid input
 *  leaves the current file and the recovery point intact and re-enables writes;
 *  the caller owns the post-success app action (restart or quit). */
export async function restoreRecoveryPoint(
  store: RestoreStore,
  id: RecoveryPointId
): Promise<RestoreRecoveryPointResult> {
  const dataFile = store.getDataFilePath()
  const backupPath = recoveryPointPath(dataFile, id)
  if (!existsSync(backupPath)) {
    return { ok: false, error: 'The selected recovery point no longer exists.' }
  }
  let backupContents: string
  try {
    backupContents = readFileSync(backupPath, 'utf-8')
    const parsed: unknown = JSON.parse(backupContents)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false, error: 'The recovery point is not a valid Orca data file.' }
    }
  } catch (error) {
    return {
      ok: false,
      error: `The recovery point could not be validated: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  // Why freeze before the safety copy: an in-flight or quit-time save landing
  // after the copy would make the safety copy stale and could clobber the
  // restored file between rename and process exit.
  store.freezeWrites()
  try {
    await store.waitForPendingWrite()
    const mode = existsSync(dataFile) ? statSync(dataFile).mode & 0o777 : 0o600
    if (existsSync(dataFile)) {
      const safetyPath = `${dataFile}${PRE_RESTORE_SAFETY_SUFFIX}`
      writeFileDurableSync(
        durableWriteTempPath(safetyPath),
        safetyPath,
        readFileSync(dataFile, 'utf-8'),
        { mode }
      )
    }
    // Durable, not merely atomic: the caller quits right after, so a rename that
    // is not fsynced to the directory can come back as the pre-restore file.
    writeFileDurableSync(durableWriteTempPath(dataFile), dataFile, backupContents, { mode })
    retireBackupRing(store)
    return { ok: true }
  } catch (error) {
    store.unfreezeWrites()
    return {
      ok: false,
      error: `Restore failed and no changes were made: ${error instanceof Error ? error.message : String(error)}`
    }
  }
}
