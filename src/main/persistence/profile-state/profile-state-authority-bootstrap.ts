import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { publishFileDurableSync } from '../../durable-file-write'
import type {
  ProfileStateAuthorityInitialState,
  ProfileStateStartupPaneAlias
} from '../loading-store/profile-state-authority'
import { Store } from '../loading-store/store'
import { isProfileStateSqliteAvailable, openProfileStateDatabase } from './profile-state-database'
import { ProfileStateSqliteAuthority } from './profile-state-sqlite-authority'
import { migrateProfileStateToSqlite } from './profile-state-migration'
import {
  PROFILE_STATE_LEGACY_BACKUP_COUNT,
  profileStateLegacyBackupPath
} from './profile-state-legacy-backup-path'
import {
  assertProfileStateCanInitialize,
  ProfileStateAuthorityBootstrapError,
  ProfileStateRecoveryRequiredError
} from './profile-state-recovery-required'
export {
  ProfileStateAuthorityBootstrapError,
  ProfileStateRecoveryRequiredError
} from './profile-state-recovery-required'
import {
  classifyProfileStateStorage,
  profileStateDatabaseFiles,
  type ProfileStateStorageClassification
} from './profile-state-storage-classification'

export { classifyProfileStateStorage } from './profile-state-storage-classification'
export type { ProfileStateStorageClassification } from './profile-state-storage-classification'

export type ProfileStateAuthorityBootstrapResult = {
  classification: ProfileStateStorageClassification
  migrated: boolean
} & (
  | {
      authority: ProfileStateSqliteAuthority
      initialState: ProfileStateAuthorityInitialState<ProfileStateSqliteAuthority>
    }
  | { authority: undefined; initialState?: never }
)

export type ProfileStateAuthorityBootstrapOptions = {
  dataFile: string
  databaseFile: string
  profileId: string
  /** Establish empty profiles before their first Store write. */
  allowEmptyProfileState?: boolean
}

/** Normalize legacy state once, then hand one validated authority to Store. */
export function bootstrapProfileStateAuthority(
  options: ProfileStateAuthorityBootstrapOptions
): ProfileStateAuthorityBootstrapResult {
  const classification = classifyProfileStateStorage(options.dataFile, options.databaseFile)
  if (classification === 'neither' && options.allowEmptyProfileState !== true) {
    return { classification, authority: undefined, migrated: false }
  }
  if (!isProfileStateSqliteAvailable()) {
    if (classification === 'neither' || classification === 'json-only') {
      return { classification, authority: undefined, migrated: false }
    }
    throw new ProfileStateAuthorityBootstrapError(
      'SQLite profile state is present but this runtime cannot validate it'
    )
  }
  if (classification === 'json-only' || classification === 'neither') {
    assertProfileStateCanInitialize(options)
  }
  if (classification === 'json-only') {
    return migrateJsonOnlyProfile(options)
  }
  if (classification === 'neither') {
    mkdirSync(dirname(options.databaseFile), { recursive: true })
    createEmptyProfileStateDatabase(options)
  } else if (classification === 'sqlite-only' && !existsSync(options.databaseFile)) {
    throw new ProfileStateAuthorityBootstrapError(
      'SQLite profile state has an orphaned database sidecar'
    )
  }

  const authority = new ProfileStateSqliteAuthority(options.databaseFile, options.profileId)
  try {
    const initialState =
      classification === 'both'
        ? authority.readAcceptedState(readFileSync(options.dataFile, 'utf8'))
        : authority.readInitialState()
    if (initialState === undefined) {
      throw new ProfileStateAuthorityBootstrapError(
        'Profile state has both JSON and SQLite storage without a matching acceptance marker'
      )
    }
    return { classification, authority, initialState, migrated: false }
  } catch (error) {
    authority.close()
    if (error instanceof ProfileStateAuthorityBootstrapError) {
      throw error
    }
    throw new ProfileStateRecoveryRequiredError(options, error)
  }
}

function createEmptyProfileStateDatabase({
  dataFile,
  databaseFile,
  profileId
}: ProfileStateAuthorityBootstrapOptions): void {
  const temporaryDatabaseFile = `${databaseFile}.empty.${process.pid}.${randomUUID()}.tmp`
  let published = false
  try {
    const opened = openProfileStateDatabase(temporaryDatabaseFile, profileId)
    opened.db.close()
    if (classifyProfileStateStorage(dataFile, databaseFile) !== 'neither') {
      throw new ProfileStateAuthorityBootstrapError(
        'Profile state storage changed while creating an empty database'
      )
    }
    assertProfileStateCanInitialize({ dataFile, databaseFile, profileId })
    if (!publishFileDurableSync(temporaryDatabaseFile, databaseFile)) {
      throw new ProfileStateAuthorityBootstrapError(
        'Profile state storage changed while creating an empty database'
      )
    }
    published = true
  } finally {
    if (!published) {
      for (const path of profileStateDatabaseFiles(temporaryDatabaseFile)) {
        rmSync(path, { force: true })
      }
    }
  }
}

function migrateJsonOnlyProfile(
  options: ProfileStateAuthorityBootstrapOptions
): ProfileStateAuthorityBootstrapResult {
  const rawJson = readFileSync(options.dataFile, 'utf8')
  const { prepared, unboundPaneAliases } = prepareLegacyProfileState(options.dataFile, rawJson)
  const migrated = migrateProfileStateToSqlite({
    ...options,
    expectedLegacyJson: rawJson,
    serializedState: prepared.json
  })
  prepared.commit()
  return {
    classification: 'json-only',
    ...migrated,
    initialState: { ...migrated.initialState, unboundPaneAliases },
    migrated: true
  }
}

function prepareLegacyProfileState(dataFile: string, rawJson: string) {
  try {
    return prepareLegacySnapshot(dataFile, rawJson)
  } catch (error) {
    // Import the first usable legacy backup without overwriting the damaged source.
    for (let index = 0; index < PROFILE_STATE_LEGACY_BACKUP_COUNT; index += 1) {
      const path = profileStateLegacyBackupPath(dataFile, index)
      if (!existsSync(path)) {
        continue
      }
      try {
        const prepared = prepareLegacySnapshot(dataFile, readFileSync(path, 'utf8'))
        console.warn(`[profile-state] Recovered legacy state from ${path}`)
        return prepared
      } catch {
        // A corrupt backup must not prevent trying the remaining legacy ring.
      }
    }
    throw new ProfileStateAuthorityBootstrapError(
      `Failed to load imported profile state or its legacy backups: ${dataFile}. ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

function prepareLegacySnapshot(dataFile: string, serializedState: string) {
  const unboundPaneAliases: ProfileStateStartupPaneAlias[] = []
  const store = new Store({
    dataFile,
    serializedState,
    collectUnboundPaneAlias: (entry) => unboundPaneAliases.push(entry)
  })
  return { prepared: store.prepareProfileStateExport(), unboundPaneAliases }
}
