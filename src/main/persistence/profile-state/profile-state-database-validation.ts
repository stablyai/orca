import { withProfileStateReadSnapshot } from './profile-state-read-snapshot'
import type Database from '../../sqlite/sync-database'
import { readCurrentAutomationRunsState } from './profile-state-automation-runs-storage'
import { readProfileStateRevision } from './profile-state-revision'
import {
  PROFILE_STATE_META_PROFILE_ID,
  PROFILE_STATE_DATABASE_SCHEMA_VERSION
} from './profile-state-database-schema'
import {
  PROFILE_STATE_AUTOMATION_RUNS_META_TABLE,
  PROFILE_STATE_AUTOMATION_RUNS_TABLE
} from './profile-state-automation-runs'
import { ProfileStateDatabaseOpenError } from './profile-state-database-errors'

export function verifyProfileStateSchema(
  db: Database.Database,
  profileId: string,
  schemaVersion = PROFILE_STATE_DATABASE_SCHEMA_VERSION
): void {
  withProfileStateReadSnapshot(db, () => {
    const tables = profileStateTableNames(db)
    if (
      !tables.has('profile_state_meta') ||
      !tables.has('profile_state_documents') ||
      (schemaVersion >= 2 &&
        (!tables.has(PROFILE_STATE_AUTOMATION_RUNS_META_TABLE) ||
          !tables.has(PROFILE_STATE_AUTOMATION_RUNS_TABLE)))
    ) {
      throw new Error('Profile state database schema is incomplete')
    }

    verifyProfileStateColumns(db, 'profile_state_meta', {
      key: { type: 'TEXT', notNull: true, primaryKey: true },
      value: { type: 'TEXT', notNull: true, primaryKey: false }
    })
    verifyProfileStateColumns(db, 'profile_state_documents', {
      domain: { type: 'TEXT', notNull: true, primaryKey: true },
      payload: { type: 'TEXT', notNull: true, primaryKey: false },
      domain_version: { type: 'INTEGER', notNull: true, primaryKey: false },
      revision: { type: 'INTEGER', notNull: true, primaryKey: false },
      updated_at: { type: 'INTEGER', notNull: true, primaryKey: false },
      content_hash: { type: 'TEXT', notNull: true, primaryKey: false }
    })
    if (schemaVersion >= 2) {
      verifyProfileStateColumns(db, PROFILE_STATE_AUTOMATION_RUNS_META_TABLE, {
        domain: { type: 'TEXT', notNull: true, primaryKey: true },
        presence: { type: 'TEXT', notNull: true, primaryKey: false },
        domain_version: { type: 'INTEGER', notNull: true, primaryKey: false },
        revision: { type: 'INTEGER', notNull: true, primaryKey: false },
        updated_at: { type: 'INTEGER', notNull: true, primaryKey: false },
        content_hash: { type: 'TEXT', notNull: true, primaryKey: false }
      })
      verifyProfileStateColumns(db, PROFILE_STATE_AUTOMATION_RUNS_TABLE, {
        run_id: { type: 'TEXT', notNull: true, primaryKey: true },
        ordinal: { type: 'INTEGER', notNull: true, primaryKey: false },
        payload: { type: 'TEXT', notNull: true, primaryKey: false },
        content_hash: { type: 'TEXT', notNull: true, primaryKey: false },
        revision: { type: 'INTEGER', notNull: true, primaryKey: false },
        updated_at: { type: 'INTEGER', notNull: true, primaryKey: false }
      })
    }

    verifyProfileStateIdentity(db, profileId)
    if (schemaVersion >= 3) {
      readCurrentAutomationRunsState(db, readProfileStateRevision(db))
    }
  })
}

export function verifyEmptyProfileStateSchema(db: Database.Database): void {
  if (profileStateTableNames(db).size > 0) {
    throw new Error('Profile state database has an unexpected version-0 schema')
  }
}

function verifyProfileStateColumns(
  db: Database.Database,
  table: string,
  expected: Readonly<Record<string, { type: string; notNull: boolean; primaryKey: boolean }>>
): void {
  const rows = db.pragma(`table_info(${table})`)
  if (!Array.isArray(rows)) {
    throw new Error(`Profile state table has no readable columns: ${table}`)
  }
  const columns = new Map<string, { type: string; notNull: boolean; primaryKey: boolean }>()
  for (const row of rows) {
    if (
      !isRecord(row) ||
      typeof row.name !== 'string' ||
      typeof row.type !== 'string' ||
      typeof row.notnull !== 'number' ||
      typeof row.pk !== 'number'
    ) {
      throw new Error(`Profile state table has malformed column metadata: ${table}`)
    }
    columns.set(row.name, {
      type: row.type.toUpperCase(),
      notNull: row.notnull === 1,
      primaryKey: row.pk === 1
    })
  }
  for (const [name, definition] of Object.entries(expected)) {
    const actual = columns.get(name)
    if (
      actual === undefined ||
      actual.type !== definition.type ||
      actual.notNull !== definition.notNull ||
      actual.primaryKey !== definition.primaryKey
    ) {
      throw new Error(`Profile state table has an incompatible column: ${table}.${name}`)
    }
  }
}

function profileStateTableNames(db: Database.Database): Set<string> {
  return new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => (isRecord(row) && typeof row.name === 'string' ? row.name : undefined))
      .filter((name): name is string => name !== undefined)
  )
}

function verifyProfileStateIdentity(db: Database.Database, profileId: string): void {
  const storedProfileIdRow = db
    .prepare('SELECT value FROM profile_state_meta WHERE key = ?')
    .get(PROFILE_STATE_META_PROFILE_ID)
  const storedProfileId =
    isRecord(storedProfileIdRow) && typeof storedProfileIdRow.value === 'string'
      ? storedProfileIdRow.value
      : undefined
  if (storedProfileId === undefined) {
    throw new Error('Profile state database is missing its profile identity')
  }
  if (storedProfileId !== profileId) {
    throw new ProfileStateDatabaseOpenError(
      'identity-mismatch',
      'Profile state database belongs to a different profile'
    )
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
