import { profileStateDatabaseFiles } from './profile-state-storage-classification'
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { durableWriteTempPath, renameDurableSync } from '../../durable-file-write'
import { hardenSqliteDatabaseFiles } from '../../sqlite/harden-database-files'
import { bestEffortFsyncDirectorySync, fsyncFileSync } from '../../../shared/secure-file'
import { openProfileStateDatabaseReadOnly } from './profile-state-database'
import { readProfileStateSnapshot } from './profile-state-documents'
import {
  profileStateDatabaseBackups,
  profileStateDatabaseBackupFiles
} from './profile-state-backup-path'
import { profileStateJsonExportPaths } from './profile-state-export-path'
import { assertProfileStateMaintenance, type ProfileStateMaintenance } from './profile-state-access'
import {
  quarantineProfileStateDatabase,
  type ProfileStateDatabaseQuarantine
} from './profile-state-database-quarantine'

export type ProfileStateDatabaseRecoveryOptions = {
  maintenance: ProfileStateMaintenance
  databasePath: string
  dataFile: string
  backupPath: string
  profileId: string
  quarantineRoot?: string
  reason?: string
  beforeRestore?: () => void
}

export type ProfileStateDatabaseRecovery = {
  revision: number
  quarantine: ProfileStateDatabaseQuarantine
  removedDatabaseFiles: readonly string[]
}

/** Replace the database family only while startup and offline access are excluded. */
export function restoreProfileStateDatabaseBackup(
  options: ProfileStateDatabaseRecoveryOptions
): ProfileStateDatabaseRecovery {
  assertProfileStateMaintenance(options.maintenance, options)
  const backups = profileStateDatabaseBackups(options.databasePath)
  if (!backups.some((backup) => backup.path === options.backupPath)) {
    throw new Error('Selected profile state database backup is not retained by this profile')
  }
  if (!lstatSync(options.backupPath).isFile()) {
    throw new Error('Profile state database backup must be a regular file')
  }
  if (['-wal', '-shm', '-journal'].some((suffix) => existsSync(`${options.backupPath}${suffix}`))) {
    throw new Error('Profile state database backup has sidecars and is not self-contained')
  }

  mkdirSync(dirname(options.databasePath), { recursive: true })
  const stagingPath = durableWriteTempPath(options.databasePath)
  try {
    copyFileSync(options.backupPath, stagingPath, constants.COPYFILE_EXCL)
    hardenSqliteDatabaseFiles(stagingPath)
    const revision = validateRecoverySnapshot(stagingPath, options.profileId)
    fsyncFileSync(stagingPath)
    const recoveryFiles = [
      ...profileStateDatabaseBackupFiles(options.databasePath),
      ...profileStateJsonExportPaths(options.dataFile),
      ...(existsSync(options.dataFile) ? [options.dataFile] : [])
    ]
    const quarantine = quarantineProfileStateDatabase(
      options.databasePath,
      options.profileId,
      options.quarantineRoot,
      options.reason ?? 'profile-state-database-rollback',
      recoveryFiles
    )
    options.beforeRestore?.()

    // JSON exports are revisioned for the legacy authority. Remove them after
    // archiving so a later SQLite revision can publish a fresh export at the
    // same number without colliding with an older divergent payload.
    const retainedJsonExports = profileStateJsonExportPaths(options.dataFile)
    for (const exportPath of retainedJsonExports) {
      rmSync(exportPath)
    }

    const removedDatabaseFiles = profileStateDatabaseFiles(options.databasePath).filter(existsSync)
    // Remove the primary first: interruption must fail closed on retained backups, never replay old WAL.
    for (const path of removedDatabaseFiles) {
      rmSync(path)
    }
    rmSync(options.dataFile, { force: true })
    bestEffortFsyncDirectorySync(dirname(options.databasePath))
    renameDurableSync(stagingPath, options.databasePath)
    return { revision, quarantine, removedDatabaseFiles }
  } finally {
    for (const path of profileStateDatabaseFiles(stagingPath)) {
      rmSync(path, { force: true })
    }
  }
}

function validateRecoverySnapshot(path: string, profileId: string): number {
  const opened = openProfileStateDatabaseReadOnly(path, profileId)
  try {
    if (opened.db.pragma('journal_mode', { simple: true }) !== 'delete') {
      throw new Error('Profile state database backup must use a self-contained journal mode')
    }
    const snapshot = readProfileStateSnapshot(opened.db)
    if (snapshot.revision === 0) {
      throw new Error('Profile state database backup contains no committed profile state')
    }
    return snapshot.revision
  } finally {
    opened.db.close()
  }
}
