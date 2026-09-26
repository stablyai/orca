import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { publishProfileStateDatabase } from './profile-state-database-publication'
import { openProfileStateDatabase } from './profile-state-database'
import { hashProfileStateJson, importProfileStateJson } from './profile-state-documents'
import { writeVersionedProfileStateExport } from './profile-state-versioned-export'
import { assertProfileStateCanInitialize } from './profile-state-recovery-required'
import { ProfileStateSqliteAuthority } from './profile-state-sqlite-authority'
import {
  classifyProfileStateStorage,
  profileStateDatabaseFiles
} from './profile-state-storage-classification'
import type { ProfileStateAuthorityInitialState } from '../loading-store/profile-state-authority'

type ProfileStateMigrationOptions = {
  dataFile: string
  databaseFile: string
  profileId: string
  expectedLegacyJson: string | undefined
  /** Storage-form state; inactive profiles retain sealed secrets without decrypting them. */
  serializedState: string
}

/** Publish an imported database only after its complete source has committed durably. */
export function migrateProfileStateToSqlite(options: ProfileStateMigrationOptions): {
  authority: ProfileStateSqliteAuthority
  initialState: ProfileStateAuthorityInitialState<ProfileStateSqliteAuthority>
} {
  assertMigrationSourceUnchanged(options)
  mkdirSync(dirname(options.databaseFile), { recursive: true })
  const temporaryDatabaseFile = `${options.databaseFile}.migration.${process.pid}.${randomUUID()}.tmp`
  let published = false
  try {
    const opened = openProfileStateDatabase(temporaryDatabaseFile, options.profileId)
    try {
      importProfileStateJson(
        opened.db,
        options.serializedState,
        options.expectedLegacyJson === undefined
          ? {}
          : { acceptedLegacyJsonHash: hashProfileStateJson(options.expectedLegacyJson) }
      )
    } finally {
      opened.db.close()
    }

    // Closing checkpoints the temporary database before its canonical path becomes visible.
    assertMigrationSourceUnchanged(options)
    if (!publishProfileStateDatabase(temporaryDatabaseFile, options.databaseFile)) {
      throw new Error('Profile state storage changed while importing legacy JSON')
    }
    published = true
    const authority = new ProfileStateSqliteAuthority(options.databaseFile, options.profileId)
    try {
      writeVersionedProfileStateExport(options.dataFile, (path) => authority.writeJsonExport(path))
      const initialState = authority.readInitialState()
      return { authority, initialState }
    } catch (error) {
      authority.close()
      throw error
    }
  } finally {
    if (!published) {
      for (const path of profileStateDatabaseFiles(temporaryDatabaseFile)) {
        rmSync(path, { force: true })
      }
    }
  }
}

function assertMigrationSourceUnchanged(options: ProfileStateMigrationOptions): void {
  assertProfileStateCanInitialize(options)
  const expectedClassification = options.expectedLegacyJson === undefined ? 'neither' : 'json-only'
  if (
    classifyProfileStateStorage(options.dataFile, options.databaseFile) !== expectedClassification
  ) {
    throw new Error('Profile state storage changed while importing legacy JSON')
  }
  const currentJson = existsSync(options.dataFile)
    ? readFileSync(options.dataFile, 'utf8')
    : undefined
  if (currentJson !== options.expectedLegacyJson) {
    throw new Error('Profile state JSON changed while importing legacy JSON')
  }
}
