import {
  readSurfaceSqlRecoveryEvidence,
  readSurfaceJsonRecoveryEvidence
} from '../../../workspace-surfaces/surface-recovery-evidence'
import { preserveSurfaceRecoveryObligations } from '../../../workspace-surfaces/surface-recovery-obligations'
import { mergeSurfaceEvidenceDocuments } from '../../../workspace-surfaces/surface-cold-evidence'
import {
  WORKSPACE_SURFACE_DOMAIN,
  surfaceProfileDomainSchema
} from '../../../../shared/workspace-surfaces/surface-profile-domain'
import { profileStateDatabaseFiles } from '../profile-state-storage-classification'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { parseProfileStateRoot } from '../profile-state-document-validation'
import { durableWriteTempPath, writeFileDurableSync } from '../../../filesystem/durable-file-write'
import { bestEffortFsyncDirectorySync } from '../../../../shared/secure-file'
import {
  quarantineProfileStateDatabase,
  type ProfileStateDatabaseQuarantine
} from '../profile-state-database-quarantine'
import { profileStateJsonExportPaths } from './profile-state-export-path'
import { profileStateDatabaseBackupFiles } from '../profile-state-backup-path'
import {
  hasProfileStateAuthorityMarker,
  profileStateAuthorityMarkerPath
} from '../profile-state-authority-marker'
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

/** Preserve failed SQLite authority before restoring the explicitly selected JSON export. */
export function restoreProfileStateJsonExport(
  options: ProfileStateJsonRecoveryOptions
): ProfileStateJsonRecovery {
  assertProfileStateMaintenance(options.maintenance, options)
  let { rawJson, selected } = readRecoveryExport(options.exportPath)
  const retainedExports = profileStateJsonExportPaths(options.dataFile)
  const retainedBackups = profileStateDatabaseBackupFiles(options.databasePath)
  const recoveryFiles = [options.exportPath, ...retainedExports, ...retainedBackups]
  const authorityMarker = profileStateAuthorityMarkerPath(options.databasePath)
  const hasAuthorityMarker = hasProfileStateAuthorityMarker(options.databasePath)
  if (hasAuthorityMarker) {
    recoveryFiles.push(authorityMarker)
  }
  if (existsSync(options.dataFile)) {
    recoveryFiles.push(options.dataFile)
  }
  const originalDatabaseFiles = profileStateDatabaseFiles(options.databasePath).filter((path) =>
    existsSync(path)
  )
  const quarantine = quarantineProfileStateDatabase(
    options.databasePath,
    options.profileId,
    options.quarantineRoot,
    options.reason ?? 'profile-state-json-rollback',
    recoveryFiles
  )

  // Invalidate caches before removing database/export evidence.
  options.beforeRestore?.()
  let carrier =
    selected[WORKSPACE_SURFACE_DOMAIN] === undefined
      ? undefined
      : surfaceProfileDomainSchema.parse(selected[WORKSPACE_SURFACE_DOMAIN])
  for (const evidence of [
    readSurfaceJsonRecoveryEvidence(options.dataFile),
    readSurfaceSqlRecoveryEvidence(options.databasePath, options.profileId)
  ]) {
    // Unreadable authority remains in the returned quarantine; only intact documents can merge.
    if (evidence.kind === 'value') {
      Object.assign(selected, mergeSurfaceEvidenceDocuments(selected, evidence.documents))
      carrier = preserveSurfaceRecoveryObligations(carrier, evidence.carrier)
    }
  }
  if (carrier || Object.keys(selected).some((key) => key.startsWith('workspaceSurfaceEvidence/'))) {
    if (carrier) {
      selected[WORKSPACE_SURFACE_DOMAIN] = preserveSurfaceRecoveryObligations(carrier, undefined)!
    }
    rawJson = JSON.stringify(selected)
  }
  mkdirSync(dirname(options.dataFile), { recursive: true })
  writeFileDurableSync(durableWriteTempPath(options.dataFile), options.dataFile, rawJson)

  const removedDatabaseFiles = [
    ...new Set([
      ...originalDatabaseFiles,
      ...profileStateDatabaseFiles(options.databasePath).filter((path) => existsSync(path))
    ])
  ]
  for (const path of removedDatabaseFiles) {
    rmSync(path, { force: true })
  }
  // Reserved exports must go or startup would reject restored JSON as a stale mirror.
  const retainedArtifacts = [...retainedBackups, ...retainedExports]
  for (const path of retainedArtifacts) {
    if (path !== options.exportPath) {
      rmSync(path)
    }
  }
  if (hasAuthorityMarker) {
    rmSync(authorityMarker)
  }
  // Keep the selected revision retryable until no reserved artifact can block JSON startup.
  if (retainedArtifacts.includes(options.exportPath)) {
    rmSync(options.exportPath)
  }
  bestEffortFsyncDirectorySync(dirname(options.databasePath))
  return { quarantine, removedDatabaseFiles }
}

function readRecoveryExport(exportPath: string): {
  rawJson: string
  selected: Record<string, unknown>
} {
  if (exportPath.length === 0 || exportPath.includes('\0')) {
    throw new Error('Profile state recovery export path is invalid')
  }
  const rawJson = readFileSync(exportPath, 'utf8')
  return { rawJson, selected: parseProfileStateRoot(rawJson) }
}
