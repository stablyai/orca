import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { publishFileDurableSync } from '../../durable-file-write'
import type {
  ProfileStateAuthority,
  ProfileStateAuthorityInitialState
} from '../loading-store/profile-state-authority'
import { Store } from '../loading-store/store'
import { isProfileStateSqliteAvailable, openProfileStateDatabase } from './profile-state-database'
import { ProfileStateSqliteAuthority } from './profile-state-sqlite-authority'
import { migrateProfileStateToSqlite } from './profile-state-migration'
import { ProfileStateRecoveryRequiredError } from './profile-state-recovery-required'
export { ProfileStateRecoveryRequiredError } from './profile-state-recovery-required'
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
  | { authority: ProfileStateAuthority; initialState: ProfileStateAuthorityInitialState }
  | { authority: undefined; initialState?: never }
)

export type ProfileStateAuthorityBootstrapOptions = {
  dataFile: string
  databaseFile: string
  profileId: string
  /** Establish empty profiles before their first Store write. */
  allowEmptyProfileState?: boolean
}

export class ProfileStateAuthorityBootstrapError extends Error {
  readonly code = 'ambiguous-profile-state' as const

  constructor(message: string) {
    super(message)
    this.name = 'ProfileStateAuthorityBootstrapError'
  }
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
  // serializedState makes malformed input fail closed and prevents backup
  // recovery or a normalization write from changing the legacy source.
  const store = new Store({ dataFile: options.dataFile, serializedState: rawJson })
  const prepared = store.prepareProfileStateExport()
  const migrated = migrateProfileStateToSqlite({
    ...options,
    expectedLegacyJson: rawJson,
    serializedState: prepared.json
  })
  prepared.commit()
  return { classification: 'json-only', ...migrated, migrated: true }
}
