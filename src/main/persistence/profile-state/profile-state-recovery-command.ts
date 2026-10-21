import { existsSync, readFileSync, rmSync } from 'node:fs'
import {
  ProfileStateRecoveryCommandError,
  type ProfileStateRecoverySelector,
  type ProfileStateExportsResult,
  type ProfileStateRollbackResult
} from '../../../shared/profile-state-recovery-command'
import { getActiveProfileStateLocation } from './profile-state-active-location'
import {
  profileStateJsonExportPath,
  profileStateJsonExportPaths
} from './legacy-json/profile-state-export-path'
import { profileStateDatabaseBackups } from './profile-state-backup-path'
import { restoreProfileStateJsonExport } from './legacy-json/profile-state-recovery'
import { restoreProfileStateDatabaseBackup } from './profile-state-database-recovery'
import { quarantineProfileStateDatabase } from './profile-state-database-quarantine'
import { ProfileStateSqliteAuthority } from './profile-state-sqlite-authority'
import { durableWriteTempPath, writeFileDurableSync } from '../../durable-file-write'
import { assertProfileStateMaintenance, type ProfileStateMaintenance } from './profile-state-access'
import {
  openProfileStateDatabaseReadOnly,
  openWritableProfileStateDatabase
} from './profile-state-database'
import {
  writeProfileStateAuthorityJsonExport,
  writeProfileStateRecoveryJsonExport
} from './legacy-json/profile-state-authority-exports'
import { writeVersionedProfileStateExport } from './legacy-json/profile-state-versioned-export'
import { readProfileStateDomain } from './profile-state-domain-reader'
import { isRecord } from './profile-state-document-validation'
import { profileHasPendingProjectMove } from '../../orca-profiles/profile-project-move-record'
import {
  invalidateHttp1CompatibilityMarker,
  writeHttp1CompatibilityMarker
} from '../../startup/http1-compatibility-marker'

export function getProfileStateExports(
  userDataPath: string,
  profileId?: string
): ProfileStateExportsResult {
  const location = getActiveProfileStateLocation(userDataPath, profileId)
  if (location === undefined) {
    throw new ProfileStateRecoveryCommandError(
      'runtime_error',
      'No active profile is available for recovery.'
    )
  }
  return {
    profileId: location.profileId,
    dataFile: location.dataFile,
    databaseFile: location.databaseFile,
    exportPaths: profileStateJsonExportPaths(location.dataFile),
    backups: profileStateDatabaseBackups(location.databaseFile)
  }
}

export function rollbackProfileState(
  userDataPath: string,
  selector: ProfileStateRecoverySelector,
  maintenance: ProfileStateMaintenance,
  profileId?: string
): ProfileStateRollbackResult {
  let result = getProfileStateExports(userDataPath, profileId)
  if (profileHasPendingProjectMove(result.profileId, userDataPath)) {
    throw new ProfileStateRecoveryCommandError(
      'runtime_error',
      'This profile has a pending project move. Resolve the move with both profiles preserved before restoring a single profile.'
    )
  }
  if (selector.kind === 'sqlite') {
    return restoreDatabaseBackup(userDataPath, result, selector.backupId, maintenance)
  }
  if (selector.kind === 'current-sqlite') {
    return adoptCurrentDatabase(userDataPath, result, maintenance)
  }
  const revision =
    selector.kind === 'latest-json'
      ? exportLatestProfileStateJson(result, maintenance)
      : selector.kind === 'json'
        ? selector.revision
        : null
  if (selector.kind === 'latest-json') {
    result = getProfileStateExports(userDataPath, profileId)
  }
  const exportPath =
    revision === null ? result.dataFile : profileStateJsonExportPath(result.dataFile, revision)
  if (revision !== null && !result.exportPaths.includes(exportPath)) {
    throw new ProfileStateRecoveryCommandError(
      'invalid_argument',
      `Profile-state export revision ${revision} is unavailable. Use profile state exports to inspect retained revisions.`
    )
  }
  const recovered = restoreProfileStateJsonExport({
    maintenance,
    databasePath: result.databaseFile,
    dataFile: result.dataFile,
    exportPath,
    profileId: result.profileId,
    ...(revision === null ? { reason: 'profile-state-adopt-current-json' } : {}),
    beforeRestore: () => invalidateActiveProfileMarker(userDataPath, result.profileId)
  })
  syncHttp1CompatibilityMarkerAfterRollback(userDataPath, result.dataFile, result.profileId)
  return {
    ...result,
    storage: 'json',
    restoredPath: result.dataFile,
    revision,
    quarantineDirectory: recovered.quarantine.directory,
    removedDatabaseFiles: recovered.removedDatabaseFiles
  }
}

function exportLatestProfileStateJson(
  profile: ProfileStateExportsResult,
  maintenance: ProfileStateMaintenance
): number {
  assertProfileStateMaintenance(maintenance, {
    profileId: profile.profileId,
    dataFile: profile.dataFile,
    databasePath: profile.databaseFile
  })
  const opened = openProfileStateDatabaseReadOnly(profile.databaseFile, profile.profileId)
  try {
    const revision = writeVersionedProfileStateExport(
      profile.dataFile,
      (targetPath) => writeProfileStateAuthorityJsonExport(opened.db, targetPath),
      { retainAllExports: true }
    )
    if (revision === undefined) {
      throw new ProfileStateRecoveryCommandError(
        'runtime_error',
        'The SQLite profile has no persisted state to export.'
      )
    }
    return revision
  } finally {
    opened.db.close()
  }
}

function restoreDatabaseBackup(
  userDataPath: string,
  result: ProfileStateExportsResult,
  backupId: string,
  maintenance: ProfileStateMaintenance
): ProfileStateRollbackResult {
  const backup = result.backups.find((entry) => entry.id === backupId)
  if (!backup) {
    throw new ProfileStateRecoveryCommandError(
      'invalid_argument',
      'Profile-state backup is unavailable. Use profile state exports to inspect retained backups.'
    )
  }
  const recovered = restoreProfileStateDatabaseBackup({
    maintenance,
    databasePath: result.databaseFile,
    dataFile: result.dataFile,
    backupPath: backup.path,
    profileId: result.profileId,
    beforeRestore: () => invalidateActiveProfileMarker(userDataPath, result.profileId)
  })
  syncHttp1CompatibilityMarkerFromDatabase(userDataPath, result)
  return {
    ...result,
    storage: 'sqlite',
    restoredPath: result.databaseFile,
    backupId: backup.id,
    revision: recovered.revision,
    quarantineDirectory: recovered.quarantine.directory,
    removedDatabaseFiles: recovered.removedDatabaseFiles
  }
}

/** Keep SQLite and replace diverged JSON (e.g. edited by an older build) with its export. */
function adoptCurrentDatabase(
  userDataPath: string,
  result: ProfileStateExportsResult,
  maintenance: ProfileStateMaintenance
): ProfileStateRollbackResult {
  maintenance.assertProfile(result.profileId, result.dataFile, result.databaseFile)
  const authority = new ProfileStateSqliteAuthority(result.databaseFile, result.profileId)
  try {
    // Validate before archiving so an unreadable database leaves both copies untouched.
    authority.readInitialState()
    if (authority.revision === 0) {
      throw new ProfileStateRecoveryCommandError(
        'runtime_error',
        'SQLite profile state is empty. Keep the current JSON instead.'
      )
    }
    const quarantine = quarantineProfileStateDatabase(
      result.databaseFile,
      result.profileId,
      undefined,
      'profile-state-adopt-current-sqlite',
      existsSync(result.dataFile) ? [result.dataFile] : []
    )
    invalidateActiveProfileMarker(userDataPath, result.profileId)
    // A retained JSON the marker never accepted would fail the compatibility export's fence.
    const divergedJson = existsSync(result.dataFile) ? readFileSync(result.dataFile) : undefined
    rmSync(result.dataFile, { force: true })
    let revision: number
    try {
      revision = republishCurrentDatabaseJson(result, authority.revision)
    } catch (error) {
      if (divergedJson !== undefined && !existsSync(result.dataFile)) {
        writeFileDurableSync(durableWriteTempPath(result.dataFile), result.dataFile, divergedJson)
      }
      throw error
    }
    syncHttp1CompatibilityMarkerFromDatabase(userDataPath, result)
    return {
      ...result,
      storage: 'sqlite',
      restoredPath: result.databaseFile,
      revision,
      quarantineDirectory: quarantine.directory,
      removedDatabaseFiles: []
    }
  } finally {
    authority.close()
  }
}

function syncHttp1CompatibilityMarkerFromDatabase(
  userDataPath: string,
  result: ProfileStateExportsResult
): void {
  if (getActiveProfileStateLocation(userDataPath)?.profileId !== result.profileId) {
    return
  }
  const settings = readProfileStateDomain(result.databaseFile, result.profileId, 'settings')
  if (settings.kind !== 'unreadable') {
    const enabled =
      settings.kind === 'value' &&
      isRecord(settings.value) &&
      settings.value.electronHttp1CompatibilityMode === true
    writeHttp1CompatibilityMarker(userDataPath, enabled, result.profileId)
  }
}

function syncHttp1CompatibilityMarkerAfterRollback(
  userDataPath: string,
  dataFile: string,
  profileId: string
): void {
  if (getActiveProfileStateLocation(userDataPath)?.profileId !== profileId) {
    return
  }
  let enabled = false
  try {
    const parsed: unknown = JSON.parse(readFileSync(dataFile, 'utf8'))
    if (isRecord(parsed) && isRecord(parsed.settings)) {
      enabled = parsed.settings.electronHttp1CompatibilityMode === true
    }
  } catch {
    // Leave the invalidated marker absent so startup reads the restored JSON itself.
    return
  }
  writeHttp1CompatibilityMarker(userDataPath, enabled, profileId)
}

function invalidateActiveProfileMarker(userDataPath: string, profileId: string): void {
  if (getActiveProfileStateLocation(userDataPath)?.profileId === profileId) {
    invalidateHttp1CompatibilityMarker(userDataPath)
  }
}

function republishCurrentDatabaseJson(
  profile: ProfileStateExportsResult,
  revision: number
): number {
  const opened = openWritableProfileStateDatabase(profile.databaseFile, profile.profileId)
  try {
    return writeProfileStateRecoveryJsonExport(opened.db, profile.dataFile, revision)
  } finally {
    opened.db.close()
  }
}
