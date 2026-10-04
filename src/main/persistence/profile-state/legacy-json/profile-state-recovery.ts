import { profileStateDatabaseFiles } from '../profile-state-storage-classification'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { parseProfileStateRoot } from '../profile-state-document-validation'
import { durableWriteTempPath, writeFileDurableSync } from '../../../durable-file-write'
import { bestEffortFsyncDirectorySync } from '../../../../shared/secure-file'
import {
  quarantineProfileStateDatabase,
  type ProfileStateDatabaseQuarantine
} from '../profile-state-database-quarantine'
import { profileStateJsonExportPaths } from './profile-state-export-path'
import { profileStateDatabaseBackupFiles } from '../profile-state-backup-path'
import {
  assertProfileStateMaintenance,
  type ProfileStateMaintenance
} from '../profile-state-access'

export type ProfileStateJsonRecoveryOptions = {
  maintenance: ProfileStateMaintenance
  databasePath: string
  dataFile: string
  exportPath: string
  profileId: string
  quarantineRoot?: string
  reason?: string
  beforeRestore?: () => void
}

export type ProfileStateJsonRecovery = {
  quarantine: ProfileStateDatabaseQuarantine
  removedDatabaseFiles: readonly string[]
}

/** Restore an explicitly selected JSON export after preserving a failed SQLite authority. */
export function restoreProfileStateJsonExport(
  options: ProfileStateJsonRecoveryOptions
): ProfileStateJsonRecovery {
  assertProfileStateMaintenance(options.maintenance, options)
  const rawJson = readRecoveryExport(options.exportPath)
  const retainedExports = profileStateJsonExportPaths(options.dataFile)
  const retainedBackups = profileStateDatabaseBackupFiles(options.databasePath)
  const recoveryFiles = [options.exportPath, ...retainedExports, ...retainedBackups]
  if (existsSync(options.dataFile)) {
    recoveryFiles.push(options.dataFile)
  }
  const quarantine = quarantineProfileStateDatabase(
    options.databasePath,
    options.profileId,
    options.quarantineRoot,
    options.reason ?? 'profile-state-json-rollback',
    recoveryFiles
  )

  // Invalidate authority-dependent caches while the database and recovery exports still exist.
  options.beforeRestore?.()
  mkdirSync(dirname(options.dataFile), { recursive: true })
  writeFileDurableSync(durableWriteTempPath(options.dataFile), options.dataFile, rawJson)

  const removedDatabaseFiles = profileStateDatabaseFiles(options.databasePath).filter((path) =>
    existsSync(path)
  )
  for (const path of removedDatabaseFiles) {
    rmSync(path)
  }
  // Removing the reserved exports completes the authority transition back to JSON. Keeping one
  // would make established startup correctly reject the restored legacy state as a stale mirror.
  const retainedArtifacts = [...retainedBackups, ...retainedExports]
  for (const path of retainedArtifacts) {
    if (path !== options.exportPath) {
      rmSync(path)
    }
  }
  // Keep the selected revision retryable until no reserved artifact can block JSON startup.
  if (retainedArtifacts.includes(options.exportPath)) {
    rmSync(options.exportPath)
  }
  bestEffortFsyncDirectorySync(dirname(options.databasePath))
  return { quarantine, removedDatabaseFiles }
}

function readRecoveryExport(exportPath: string): string {
  if (exportPath.length === 0 || exportPath.includes('\0')) {
    throw new Error('Profile state recovery export path is invalid')
  }
  const rawJson = readFileSync(exportPath, 'utf8')
  parseProfileStateRoot(rawJson)
  return rawJson
}
