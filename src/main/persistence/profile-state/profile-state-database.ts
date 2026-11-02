import { withProfileStateWriteTransaction } from './profile-state-write-transaction'
import { hasProfileStateAuthorityMarker } from './profile-state-authority-marker'
import Database, { isSqliteAvailable } from '../../sqlite/sync-database'
import { migrateAutomationRunsStorage } from './profile-state-automation-runs-migration'
import { hardenSqliteDatabaseFiles } from '../../sqlite/harden-database-files'
import {
  createProfileStateTablesSql,
  PROFILE_STATE_DATABASE_SCHEMA_VERSION,
  PROFILE_STATE_META_PROFILE_ID
} from './profile-state-database-schema'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  PROFILE_STATE_DATABASE_FILE_NAME,
  profileStateDatabaseFile
} from '../../../shared/profile-state-storage-paths'
import {
  ProfileStateDatabaseOpenError,
  type ProfileStateDatabaseOpenErrorCode
} from './profile-state-database-errors'
import {
  verifyEmptyProfileStateSchema,
  verifyProfileStateSchema
} from './profile-state-database-validation'

export const PROFILE_STATE_BUSY_TIMEOUT_MS = 5_000

// Keep relay-only Node 18 imports safe while selecting the actual database driver.
export const isProfileStateSqliteAvailable = isSqliteAvailable

export { ProfileStateDatabaseOpenError }
export type { ProfileStateDatabaseOpenErrorCode }

export type OpenProfileStateDatabase = {
  db: Database.Database
  readOnly: boolean
  profileId: string
}

export { PROFILE_STATE_DATABASE_FILE_NAME, profileStateDatabaseFile }

export function openWritableProfileStateDatabase(
  databasePath: string,
  profileId: string
): OpenProfileStateDatabase {
  mkdirSync(dirname(databasePath), { recursive: true })
  const opened = openProfileStateDatabase(databasePath, profileId)
  if (opened.readOnly) {
    opened.db.close()
    throw new ProfileStateDatabaseOpenError(
      'newer-schema',
      'This profile requires a newer version of Orca'
    )
  }
  return opened
}

/** Validate schema before WAL/DDL setup so unknown or malformed databases remain untouched. */
export function openProfileStateDatabase(
  dbPath: string,
  profileId: string
): OpenProfileStateDatabase {
  if (profileId.length === 0) {
    throw new ProfileStateDatabaseOpenError('invalid-profile-id', 'Profile ID cannot be empty')
  }

  let probe: Database.Database
  try {
    probe = new Database(dbPath, { fileMustExist: hasProfileStateAuthorityMarker(dbPath) })
  } catch (error) {
    throw new ProfileStateDatabaseOpenError(
      'unreadable',
      `Unable to open profile state database: ${dbPath}`,
      error
    )
  }

  let transferred = false
  try {
    const storedVersion = profileStatePragmaNumber(probe, 'user_version')
    verifyProfileStateIntegrity(probe)
    if (storedVersion > PROFILE_STATE_DATABASE_SCHEMA_VERSION) {
      probe.close()
      transferred = true
      try {
        return {
          db: new Database(dbPath, {
            readonly: true,
            fileMustExist: true,
            timeout: PROFILE_STATE_BUSY_TIMEOUT_MS
          }),
          readOnly: true,
          profileId
        }
      } catch (error) {
        throw new ProfileStateDatabaseOpenError(
          'unreadable',
          `Unable to open future profile state database read-only: ${dbPath}`,
          error
        )
      }
    }

    if (storedVersion > 0) {
      // Reject incomplete schemas before any pragma can change the header.
      verifyProfileStateSchema(probe, profileId, storedVersion)
    } else if (storedVersion === 0) {
      verifyEmptyProfileStateSchema(probe)
    } else {
      throw new Error(`Unsupported profile state database schema: ${storedVersion}`)
    }

    // journal_mode can change the header even without row writes; validate everything first.
    migrateProfileStateSchema(probe, storedVersion, profileId)
    configureProfileStatePragmas(probe)
    hardenSqliteDatabaseFiles(dbPath)
    transferred = true
    return { db: probe, readOnly: false, profileId }
  } catch (error) {
    if (error instanceof ProfileStateDatabaseOpenError) {
      throw error
    }
    throw new ProfileStateDatabaseOpenError(
      'unreadable',
      `Unable to initialize profile state database: ${dbPath}`,
      error
    )
  } finally {
    if (!transferred) {
      probe.close()
    }
  }
}

/** No migrations or journal changes; GC must fail closed when an authoritative database cannot be read. */
export function openProfileStateDatabaseReadOnly(
  dbPath: string,
  profileId: string
): OpenProfileStateDatabase {
  if (profileId.length === 0) {
    throw new ProfileStateDatabaseOpenError('invalid-profile-id', 'Profile ID cannot be empty')
  }
  if (!existsSync(dbPath)) {
    throw new ProfileStateDatabaseOpenError(
      'unreadable',
      `Profile state database does not exist: ${dbPath}`
    )
  }

  let db: Database.Database
  try {
    db = new Database(dbPath, {
      readonly: true,
      fileMustExist: true,
      timeout: PROFILE_STATE_BUSY_TIMEOUT_MS
    })
  } catch (error) {
    throw new ProfileStateDatabaseOpenError(
      'unreadable',
      `Unable to open profile state database read-only: ${dbPath}`,
      error
    )
  }

  try {
    const storedVersion = profileStatePragmaNumber(db, 'user_version')
    verifyProfileStateIntegrity(db)
    if (storedVersion > PROFILE_STATE_DATABASE_SCHEMA_VERSION) {
      throw new ProfileStateDatabaseOpenError(
        'newer-schema',
        `Profile state database schema is newer than this runtime: ${storedVersion}`
      )
    }
    if (storedVersion !== PROFILE_STATE_DATABASE_SCHEMA_VERSION) {
      throw new Error(`Unsupported profile state database schema: ${storedVersion}`)
    }
    verifyProfileStateSchema(db, profileId)
    return { db, readOnly: true, profileId }
  } catch (error) {
    db.close()
    if (error instanceof ProfileStateDatabaseOpenError) {
      throw error
    }
    throw new ProfileStateDatabaseOpenError(
      'unreadable',
      `Unable to read profile state database: ${dbPath}`,
      error
    )
  }
}

export function profileStatePragmaNumber(db: Database.Database, name: string): number {
  return Number(db.pragma(name, { simple: true }) ?? 0)
}

function verifyProfileStateIntegrity(db: Database.Database): void {
  const result = db.pragma('quick_check', { simple: true })
  if (result !== 'ok') {
    throw new Error(`Profile state database integrity check failed: ${String(result)}`)
  }
}

function configureProfileStatePragmas(db: Database.Database): void {
  const journalMode = db.pragma('journal_mode = WAL', { simple: true })
  if (typeof journalMode !== 'string' || journalMode.toLowerCase() !== 'wal') {
    throw new Error(`Profile state database does not support WAL (mode: ${String(journalMode)})`)
  }
  db.pragma(`busy_timeout = ${PROFILE_STATE_BUSY_TIMEOUT_MS}`)
  db.pragma('foreign_keys = ON')
  // User state needs FULL durability; macOS checkpoints also need F_FULLFSYNC to flush drive caches.
  db.pragma('synchronous = FULL')
  db.pragma('checkpoint_fullfsync = ON')
}

function migrateProfileStateSchema(
  db: Database.Database,
  storedVersion: number,
  profileId: string
): void {
  if (storedVersion >= PROFILE_STATE_DATABASE_SCHEMA_VERSION) {
    return
  }

  return withProfileStateWriteTransaction(db, () => {
    db.exec(createProfileStateTablesSql())
    db.prepare('INSERT OR IGNORE INTO profile_state_meta (key, value) VALUES (?, ?)').run(
      PROFILE_STATE_META_PROFILE_ID,
      profileId
    )
    migrateAutomationRunsStorage(db, storedVersion)
    verifyProfileStateSchema(db, profileId)
    db.pragma(`user_version = ${PROFILE_STATE_DATABASE_SCHEMA_VERSION}`)
  })
}
