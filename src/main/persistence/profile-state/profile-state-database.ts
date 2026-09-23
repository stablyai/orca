import { withProfileStateWriteTransaction } from './profile-state-write-transaction'
import Database from '../../sqlite/sync-database'
import { migrateAutomationRunsStorage } from './profile-state-automation-runs-migration'
import { hardenSqliteDatabaseFiles } from '../../sqlite/harden-database-files'
import {
  createProfileStateTablesSql,
  PROFILE_STATE_DATABASE_SCHEMA_VERSION,
  PROFILE_STATE_META_PROFILE_ID
} from './profile-state-database-schema'
import { existsSync } from 'node:fs'
import {
  PROFILE_STATE_DATABASE_FILE_NAME,
  profileStateDatabaseFile
} from '../../../shared/profile-state-storage-paths'
import { isRecord } from './profile-state-document-validation'
import {
  ProfileStateDatabaseOpenError,
  type ProfileStateDatabaseOpenErrorCode
} from './profile-state-database-errors'
import {
  verifyEmptyProfileStateSchema,
  verifyProfileStateSchema
} from './profile-state-database-validation'

export const PROFILE_STATE_BUSY_TIMEOUT_MS = 5_000

/**
 * Probe SQLite without importing the builtin at module evaluation time.
 *
 * The packaged orcad runtime still supports Node 18, where `node:sqlite` does
 * not exist. Keeping this probe beside the opener gives every authority
 * selector the same capability decision and keeps that runtime's module graph
 * safe to load.
 */
export function isProfileStateSqliteAvailable(): boolean {
  if (typeof process.getBuiltinModule !== 'function') {
    return false
  }
  try {
    const sqlite: unknown = process.getBuiltinModule('node:sqlite')
    return (
      isRecord(sqlite) &&
      typeof sqlite.DatabaseSync === 'function' &&
      typeof sqlite.backup === 'function'
    )
  } catch {
    return false
  }
}

export { ProfileStateDatabaseOpenError }
export type { ProfileStateDatabaseOpenErrorCode }

export type OpenProfileStateDatabase = {
  db: Database.Database
  readOnly: boolean
  profileId: string
}

export { PROFILE_STATE_DATABASE_FILE_NAME, profileStateDatabaseFile }

/**
 * Open the database belonging to one profile.
 *
 * The schema version is read before WAL, busy-timeout, or DDL configuration so
 * a newer build can leave the database byte-for-byte untouched and read it
 * without accidentally writing through an unknown schema.
 */
export function openProfileStateDatabase(
  dbPath: string,
  profileId: string
): OpenProfileStateDatabase {
  if (profileId.length === 0) {
    throw new ProfileStateDatabaseOpenError('invalid-profile-id', 'Profile ID cannot be empty')
  }

  let probe: Database.Database
  try {
    probe = new Database(dbPath)
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
      // Validate the complete current shape before WAL setup. A structurally
      // valid but incomplete database should fail without changing its header.
      verifyProfileStateSchema(probe, profileId, storedVersion)
    } else if (storedVersion === 0) {
      verifyEmptyProfileStateSchema(probe)
    } else {
      throw new Error(`Unsupported profile state database schema: ${storedVersion}`)
    }

    // The journal-mode pragma can update the SQLite header even when no state
    // row is written, so all known-shape validation happens before this point.
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

/**
 * Open an existing profile database without applying migrations or changing
 * its journal mode. Callers use this for best-effort reads during GC, where a
 * present database is authoritative and any failure must fail closed.
 */
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
        'unreadable',
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
  // Profile commits are user-visible state. Keep the same power-loss contract
  // as the current temp-file + fsync writer rather than the orchestration DB's
  // cache-oriented NORMAL setting.
  db.pragma('synchronous = FULL')
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
