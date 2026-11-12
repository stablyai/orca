import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { getDefaultPersistedState } from '../../../shared/constants'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { LoadedCohortMigrationOperations } from '../../persistence/loading-store/profile-loading/loaded-cohort-migrations'
import { acquireProfileStateRuntimeAdmission } from '../../persistence/profile-state/access/profile-state-access'
import '../../persistence/profile-state/database/profile-state-database'
import { isSqliteAvailable } from '../../sqlite/sync-database'
import { migrateProfileStateToSqlite } from '../../persistence/profile-state/startup/profile-state-migration'
import {
  getOrcaProfileDataFile,
  getOrcaProfileStateDatabaseFile,
  getProfileUserDataPath
} from '../profile-storage-paths'

export function initializeNewOrcaProfileState(
  profileId: string,
  telemetry: GlobalSettings['telemetry'],
  userDataPath = getProfileUserDataPath()
): void {
  if (!isSqliteAvailable()) {
    throw new Error('Creating profile state requires the bundled Orca runtime.')
  }
  const admission = acquireProfileStateRuntimeAdmission(userDataPath)
  try {
    const dataFile = getOrcaProfileDataFile(profileId, userDataPath)
    const databaseFile = getOrcaProfileStateDatabaseFile(profileId, userDataPath)
    if (existsSync(dataFile) || existsSync(databaseFile)) {
      return
    }
    const defaults = getDefaultPersistedState(homedir())
    const cohorts = new LoadedCohortMigrationOperations({ loadNeedsSave: false })
    // Inherited consent belongs to an install that already existed, so its milestone cohort is not fresh.
    const initial = cohorts.migrateCohortSeeds(
      telemetry
        ? cohorts.migrateTelemetry(
            {
              ...defaults,
              settings: {
                ...defaults.settings,
                telemetry: { ...telemetry, protectedMilestones: { installCohort: 'existing' } }
              }
            },
            true
          )
        : cohorts.migrateTelemetry(defaults, false),
      false
    )
    const migrated = migrateProfileStateToSqlite({
      dataFile,
      databaseFile,
      profileId,
      expectedLegacyJson: undefined,
      serializedState: JSON.stringify({
        ...initial,
        chatUiLaunchTipAudience: cohorts.captureChatUiLaunchTipAudience(undefined)
      })
    })
    migrated.authority.close()
  } finally {
    admission.release()
  }
}
