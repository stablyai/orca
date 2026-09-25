import { readFileSync } from 'node:fs'
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
} from './profile-state-export-path'
import { profileStateDatabaseBackups } from './profile-state-backup-path'
import { restoreProfileStateJsonExport } from './profile-state-recovery'
import { restoreProfileStateDatabaseBackup } from './profile-state-database-recovery'
import type { ProfileStateMaintenance } from './profile-state-access'
import { readProfileStateDomain } from './profile-state-domain-reader'
import { isRecord } from './profile-state-document-validation'
import { profileHasPendingProjectMove } from '../../orca-profiles/profile-project-move-record'
import {
  invalidateHttp1CompatibilityMarker,
  writeHttp1CompatibilityMarker
} from '../../startup/http1-compatibility-marker'

export function getProfileStateExports(userDataPath: string): ProfileStateExportsResult {
  const location = getActiveProfileStateLocation(userDataPath)
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
  maintenance: ProfileStateMaintenance
): ProfileStateRollbackResult {
  const result = getProfileStateExports(userDataPath)
  if (profileHasPendingProjectMove(result.profileId, userDataPath)) {
    throw new ProfileStateRecoveryCommandError(
      'runtime_error',
      'This profile has a pending project move. Resolve the move with both profiles preserved before restoring a single profile.'
    )
  }
  if (selector.kind === 'sqlite') {
    return restoreDatabaseBackup(userDataPath, result, selector.backupId, maintenance)
  }
  const revision = selector.revision
  const exportPath = profileStateJsonExportPath(result.dataFile, revision)
  if (!result.exportPaths.includes(exportPath)) {
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
    beforeRestore: () => invalidateHttp1CompatibilityMarker(userDataPath)
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
    beforeRestore: () => invalidateHttp1CompatibilityMarker(userDataPath)
  })
  const settings = readProfileStateDomain(result.databaseFile, result.profileId, 'settings')
  if (settings.kind !== 'unreadable') {
    const enabled =
      settings.kind === 'value' &&
      isRecord(settings.value) &&
      settings.value.electronHttp1CompatibilityMode === true
    writeHttp1CompatibilityMarker(userDataPath, enabled, result.profileId)
  }
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

function syncHttp1CompatibilityMarkerAfterRollback(
  userDataPath: string,
  dataFile: string,
  profileId: string
): void {
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
