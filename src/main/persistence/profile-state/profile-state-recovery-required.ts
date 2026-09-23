import { profileStateJsonExportPaths } from './profile-state-export-path'
import { profileStateDatabaseBackups } from './profile-state-backup-path'

type ProfileStateRecoveryLocation = {
  dataFile: string
  databaseFile: string
  profileId: string
}

/** Startup can surface this error with the exact artifacts an explicit rollback may use. */
export class ProfileStateRecoveryRequiredError extends Error {
  readonly code = 'profile-state-recovery-required' as const
  readonly dataFile: string
  readonly databaseFile: string
  readonly exportPaths: readonly string[]
  readonly backupPaths: readonly string[]

  constructor(options: ProfileStateRecoveryLocation, cause: unknown) {
    super(
      `SQLite profile state could not be read; choose a retained backup or JSON export to recover the profile`,
      { cause }
    )
    this.name = 'ProfileStateRecoveryRequiredError'
    this.dataFile = options.dataFile
    this.databaseFile = options.databaseFile
    // Recovery guidance must survive a permissions failure while enumerating the directory.
    // The startup error still names the canonical paths and remains typed for fail-closed handling.
    try {
      this.exportPaths = profileStateJsonExportPaths(options.dataFile)
    } catch {
      this.exportPaths = []
    }
    try {
      this.backupPaths = profileStateDatabaseBackups(options.databaseFile).map(({ path }) => path)
    } catch {
      this.backupPaths = []
    }
  }
}

/** A retained migration export proves that absent SQLite is not a fresh profile. */
export function assertNoRetainedProfileStateExports(options: ProfileStateRecoveryLocation): void {
  let hasRetainedExport: boolean
  try {
    hasRetainedExport =
      profileStateJsonExportPaths(options.dataFile).length > 0 ||
      profileStateDatabaseBackups(options.databaseFile).length > 0
  } catch {
    throw new ProfileStateRecoveryRequiredError(
      options,
      new Error('Could not enumerate retained profile state exports')
    )
  }
  if (hasRetainedExport) {
    throw new ProfileStateRecoveryRequiredError(
      options,
      new Error('SQLite profile state is missing while retained migration exports exist')
    )
  }
}
