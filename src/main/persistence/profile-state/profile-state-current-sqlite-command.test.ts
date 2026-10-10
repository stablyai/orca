import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  acquireProfileStateMaintenance,
  acquireProfileStateRuntimeAdmission
} from './profile-state-access'
import { rollbackProfileState } from './profile-state-recovery-command'
import {
  bootstrapProfileStateAuthority,
  ProfileStateAuthorityBootstrapError
} from './profile-state-authority-bootstrap'
import { migrateProfileStateToSqlite } from './profile-state-migration'
import { profileStateJsonExportPath } from './legacy-json/profile-state-export-path'
import { isDivergedProfileStateFailure } from './profile-state-startup-failure'

const roots: string[] = []
const profileId = 'current-sqlite-recovery'
const sqliteState = { settings: { theme: 'dark', electronHttp1CompatibilityMode: true } }
const editedJson = JSON.stringify({ settings: { theme: 'light' } })

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'orca-current-sqlite-'))
  roots.push(root)
  const directory = join(root, 'profiles', profileId)
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    join(root, 'orca-profile-index.json'),
    JSON.stringify({ activeProfileId: profileId, profiles: [{ id: profileId }] })
  )
  const dataFile = join(directory, 'orca-data.json')
  const databaseFile = join(directory, 'profile-state.db')
  const originalJson = JSON.stringify(sqliteState)
  writeFileSync(dataFile, originalJson)
  migrateProfileStateToSqlite({
    dataFile,
    databaseFile,
    profileId,
    expectedLegacyJson: originalJson,
    serializedState: originalJson
  }).authority.close()
  writeFileSync(dataFile, editedJson)
  return { root, dataFile, databaseFile, profileId }
}

function rollback(profile: ReturnType<typeof fixture>) {
  const maintenance = acquireProfileStateMaintenance(profile.root)
  try {
    return rollbackProfileState(profile.root, { kind: 'current-sqlite' }, maintenance)
  } finally {
    maintenance.release()
  }
}

describe('keeping SQLite over JSON edited by an older build', () => {
  it('tags the startup failure as a user-resolvable divergence', () => {
    const profile = fixture()
    let failure: unknown
    try {
      bootstrapProfileStateAuthority(profile)
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(ProfileStateAuthorityBootstrapError)
    expect(isDivergedProfileStateFailure(failure)).toBe(true)
    expect(isDivergedProfileStateFailure(new ProfileStateAuthorityBootstrapError('other'))).toBe(
      false
    )
  })

  it('archives the diverged JSON and republishes JSON that SQLite accepts', () => {
    const profile = fixture()
    const databaseBefore = readFileSync(profile.databaseFile)
    const result = rollback(profile)
    expect(result).toMatchObject({
      storage: 'sqlite',
      restoredPath: profile.databaseFile,
      revision: 1,
      removedDatabaseFiles: []
    })
    expect(result.backupId).toBeUndefined()
    expect(readFileSync(join(result.quarantineDirectory, 'orca-data.json'), 'utf8')).toBe(
      editedJson
    )
    expect(readFileSync(join(result.quarantineDirectory, 'profile-state.db'))).toEqual(
      databaseBefore
    )
    expect(JSON.parse(readFileSync(profile.dataFile, 'utf8'))).toEqual(sqliteState)

    const reopened = bootstrapProfileStateAuthority(profile)
    try {
      expect(reopened.migrated).toBe(false)
      expect(JSON.parse(reopened.authority?.readSerializedState() ?? 'null')).toEqual(sqliteState)
    } finally {
      reopened.authority?.close()
    }
    acquireProfileStateRuntimeAdmission(profile.root).release()
  })

  it('replaces JSON that an older build left unparseable', () => {
    const profile = fixture()
    writeFileSync(profile.dataFile, 'not json')
    const result = rollback(profile)
    expect(readFileSync(join(result.quarantineDirectory, 'orca-data.json'), 'utf8')).toBe(
      'not json'
    )
    expect(JSON.parse(readFileSync(profile.dataFile, 'utf8'))).toEqual(sqliteState)
  })

  it('leaves both copies untouched when SQLite is unreadable', () => {
    const profile = fixture()
    writeFileSync(profile.databaseFile, 'broken database')
    expect(() => rollback(profile)).toThrow()
    expect(readFileSync(profile.databaseFile, 'utf8')).toBe('broken database')
    expect(readFileSync(profile.dataFile, 'utf8')).toBe(editedJson)
  })

  it('restores the diverged JSON when republishing fails', () => {
    const profile = fixture()
    writeFileSync(profileStateJsonExportPath(profile.dataFile, 1), '{"conflicting":true}')
    expect(() => rollback(profile)).toThrow('already exists with different content')
    expect(readFileSync(profile.dataFile, 'utf8')).toBe(editedJson)
  })

  it('refuses while a profile owner holds admission', () => {
    const profile = fixture()
    const admission = acquireProfileStateRuntimeAdmission(profile.root)
    try {
      expect(() => rollback(profile)).toThrow('in use')
      expect(readFileSync(profile.dataFile, 'utf8')).toBe(editedJson)
      expect(existsSync(profile.databaseFile)).toBe(true)
    } finally {
      admission.release()
    }
  })
})
