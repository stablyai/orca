import {
  readSurfaceSqlRecoveryEvidence,
  readSurfaceJsonRecoveryEvidence,
  readSurfaceSqlEvidenceDocuments
} from '../../workspace-surfaces/surface-recovery-evidence'
import { preserveSurfaceRecoveryObligations } from '../../workspace-surfaces/surface-recovery-obligations'
import { mergeSurfaceEvidenceDocuments } from '../../workspace-surfaces/surface-cold-evidence'
import {
  WORKSPACE_SURFACE_DOMAIN,
  surfaceProfileDomainSchema,
  emptySurfaceProfileDomain
} from '../../../shared/workspace-surfaces/surface-profile-domain'
import { readProfileStateDomainsWithRevisionFromDatabase } from './profile-state-domain-reader'
import { withProfileStateWriteTransaction } from './profile-state-write-transaction'
import { writeProfileStateDomainsInTransaction } from './profile-state-domain-writes'
import {
  openWritableProfileStateDatabase,
  openProfileStateDatabaseReadOnly
} from './profile-state-database'
import { profileStateDatabaseFiles } from './profile-state-storage-classification'
import { existsSync, lstatSync, mkdirSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { durableWriteTempPath, renameDurableSync } from '../../filesystem/durable-file-write'
import { hardenSqliteDatabaseFiles } from '../../sqlite/harden-database-files'
import { bestEffortFsyncDirectorySync, fsyncFileSync } from '../../../shared/secure-file'

import { validateProfileStateSnapshot } from './profile-state-documents'
import { copyProfileStateRecoveryFile } from './profile-state-recovery-copy'
import {
  profileStateDatabaseBackups,
  profileStateDatabaseBackupFiles
} from './profile-state-backup-path'
import { profileStateJsonExportPaths } from './legacy-json/profile-state-export-path'
import {
  ensureProfileStateAuthorityMarker,
  hasProfileStateAuthorityMarker,
  profileStateAuthorityMarkerPath
} from './profile-state-authority-marker'
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

/** Require maintenance ownership to exclude startup and offline access during replacement. */
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
    copyProfileStateRecoveryFile(options.backupPath, stagingPath)
    hardenSqliteDatabaseFiles(stagingPath)
    validateRecoverySnapshot(stagingPath, options.profileId)
    const recoveryFiles = [
      ...profileStateDatabaseBackupFiles(options.databasePath),
      ...profileStateJsonExportPaths(options.dataFile),
      ...(hasProfileStateAuthorityMarker(options.databasePath)
        ? [profileStateAuthorityMarkerPath(options.databasePath)]
        : []),
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
    const laterJson = readSurfaceJsonRecoveryEvidence(options.dataFile)
    const laterSql = readSurfaceSqlRecoveryEvidence(options.databasePath, options.profileId)
    const keepCurrentPrimary = existsSync(options.databasePath) && laterSql.kind !== 'unreadable'
    const staged = openWritableProfileStateDatabase(stagingPath, options.profileId)
    try {
      const selected = readProfileStateDomainsWithRevisionFromDatabase(staged.db, [
        WORKSPACE_SURFACE_DOMAIN
      ])
      if (selected.kind === 'unreadable') {
        throw selected.error
      }
      const value = selected.values.get(WORKSPACE_SURFACE_DOMAIN)
      let merged = value === undefined ? undefined : surfaceProfileDomainSchema.parse(value)
      const documents = new Map<string, unknown>()
      const selectedDocuments = readSurfaceSqlEvidenceDocuments(staged.db)
      for (const evidence of [laterJson, laterSql]) {
        // Unreadable authority remains in the returned quarantine; only intact documents can merge.
        if (evidence.kind === 'value') {
          for (const [key, value] of Object.entries(
            mergeSurfaceEvidenceDocuments(selectedDocuments, evidence.documents)
          )) {
            documents.set(key, value)
            selectedDocuments[key] = value
          }
          merged = preserveSurfaceRecoveryObligations(merged, evidence.carrier)
        }
      }
      if (merged || documents.size) {
        merged ??= emptySurfaceProfileDomain()
        if (merged) {
          merged = preserveSurfaceRecoveryObligations(merged, undefined)!
        }
        withProfileStateWriteTransaction(staged.db, () =>
          writeProfileStateDomainsInTransaction(
            staged.db,
            {
              expectedRevision: selected.revision,
              replacements: [
                ...(merged
                  ? [{ domain: WORKSPACE_SURFACE_DOMAIN, payload: JSON.stringify(merged) }]
                  : []),
                ...[...documents].map(([domain, value]) => ({
                  domain,
                  payload: JSON.stringify(value)
                }))
              ]
            },
            merged
          )
        )
      }
    } finally {
      staged.db.close()
    }
    const revision = validateRecoverySnapshot(stagingPath, options.profileId)
    fsyncFileSync(stagingPath)
    ensureProfileStateAuthorityMarker(options.databasePath)

    const retainedJsonExports = profileStateJsonExportPaths(options.dataFile)

    const removedDatabaseFiles = profileStateDatabaseFiles(options.databasePath).filter(existsSync)
    // Remove the primary first: interruption must fail closed on retained backups, never replay old WAL.
    for (const path of removedDatabaseFiles) {
      if (!keepCurrentPrimary || path !== options.databasePath) {
        rmSync(path)
      }
    }
    bestEffortFsyncDirectorySync(dirname(options.databasePath))
    renameDurableSync(stagingPath, options.databasePath)
    // Keep every later carrier available to retry until the enriched replacement is durable.
    rmSync(options.dataFile, { force: true })
    for (const exportPath of retainedJsonExports) {
      rmSync(exportPath)
    }
    bestEffortFsyncDirectorySync(dirname(options.databasePath))
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
    const revision = validateProfileStateSnapshot(opened.db)
    if (revision === 0) {
      throw new Error('Profile state database backup contains no committed profile state')
    }
    return revision
  } finally {
    opened.db.close()
  }
}
