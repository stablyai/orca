import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  acquireProfileStateMaintenance,
  acquireProfileStateRuntimeAdmission
} from './profile-state-access'
import { rollbackProfileState } from './profile-state-recovery-command'
import { bootstrapProfileStateAuthority } from './profile-state-authority-bootstrap'
import { migrateProfileStateToSqlite } from './profile-state-migration'
import {
  createProfileStateDatabaseBackupId,
  profileStateDatabaseBackupPath
} from './profile-state-backup-path'
import { profileStateJsonExportPath } from './profile-state-export-path'
const roots: string[] = []
const profileId = 'current-json-recovery'
const originalState = { settings: { theme: 'dark', httpProxyUrl: 'sealed:original' } }
const editedState = {
  settings: {
    theme: 'light',
    httpProxyUrl: 'sealed:older-build',
    electronHttp1CompatibilityMode: true
  },
  futureDomain: { opaque: [null, '\ud800', { futureKey: 'keep me' }] },
  accounts: { token: 'sealed:account-token' }
}
const editedJson = `${JSON.stringify(editedState, null, 2)}\n`

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
  const root = mkdtempSync(join(tmpdir(), 'orca-current-json-'))
  roots.push(root)
  const directory = join(root, 'profiles', profileId)
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    join(root, 'orca-profile-index.json'),
    JSON.stringify({ activeProfileId: profileId, profiles: [{ id: profileId }] })
  )
  const dataFile = join(directory, 'orca-data.json')
  const databaseFile = join(directory, 'profile-state.db')
  const exportPath = profileStateJsonExportPath(dataFile, 1)
  const originalJson = JSON.stringify(originalState)
  writeFileSync(dataFile, originalJson)
  const migration = migrateProfileStateToSqlite({
    dataFile,
    databaseFile,
    profileId,
    expectedLegacyJson: originalJson,
    serializedState: originalJson
  })
  migration.authority.close()
  const backupPath = profileStateDatabaseBackupPath(
    databaseFile,
    createProfileStateDatabaseBackupId()
  )
  writeFileSync(backupPath, readFileSync(databaseFile))
  writeFileSync(dataFile, editedJson)
  return { root, directory, dataFile, databaseFile, exportPath, backupPath, profileId }
}

function rollback(profile: ReturnType<typeof fixture>) {
  const maintenance = acquireProfileStateMaintenance(profile.root)
  try {
    expect(() => acquireProfileStateRuntimeAdmission(profile.root)).toThrow('in use')
    return rollbackProfileState(profile.root, { kind: 'current-json' }, maintenance)
  } finally {
    maintenance.release()
  }
}

function snapshot(profile: ReturnType<typeof fixture>) {
  return [profile.dataFile, profile.databaseFile, profile.exportPath, profile.backupPath].map(
    (path) => readFileSync(path)
  )
}

describe('adopting JSON edited by an older build', () => {
  it('preserves both authorities and retained exports before adopting exact JSON bytes', async () => {
    const profile = fixture()
    const before = snapshot(profile)
    const previousQuarantine = join(profile.directory, 'profile-state-corrupt-earlier')
    mkdirSync(previousQuarantine)
    writeFileSync(join(previousQuarantine, 'evidence'), 'preserve earlier recovery')
    expect(() => bootstrapProfileStateAuthority(profile)).toThrow('acceptance marker')
    const result = rollback(profile)
    expect(result).toMatchObject({
      revision: null,
      storage: 'json',
      restoredPath: profile.dataFile
    })
    expect(readFileSync(profile.dataFile, 'utf8')).toBe(editedJson)
    expect(existsSync(profile.databaseFile)).toBe(false)
    expect(existsSync(profile.exportPath)).toBe(false)
    expect(existsSync(profile.backupPath)).toBe(false)
    expect(readFileSync(join(previousQuarantine, 'evidence'), 'utf8')).toBe(
      'preserve earlier recovery'
    )
    for (const [index, path] of [
      profile.dataFile,
      profile.databaseFile,
      profile.exportPath,
      profile.backupPath
    ].entries()) {
      expect(readFileSync(join(result.quarantineDirectory, basename(path)))).toEqual(before[index])
    }
    const reopened = bootstrapProfileStateAuthority(profile)
    expect(reopened.migrated).toBe(true)
    try {
      const restored: unknown = JSON.parse(reopened.authority?.readSerializedState() ?? 'null')
      expect(restored).toMatchObject(editedState)
    } finally {
      reopened.authority?.close()
    }
    acquireProfileStateRuntimeAdmission(profile.root).release()
  })

  it.each(['invalid JSON', '[]', 'null'])(
    'refuses invalid current JSON without changing either authority: %s',
    async (raw) => {
      const profile = fixture()
      writeFileSync(profile.dataFile, raw)
      const before = snapshot(profile)
      expect(() => rollback(profile)).toThrow('Profile state JSON')
      expect(snapshot(profile)).toEqual(before)
    }
  )

  it('refuses a missing canonical JSON without choosing a retained export', async () => {
    const profile = fixture()
    rmSync(profile.dataFile)
    const before = readFileSync(profile.databaseFile)
    expect(() => rollback(profile)).toThrow('ENOENT')
    expect(readFileSync(profile.databaseFile)).toEqual(before)
    expect(existsSync(profile.exportPath)).toBe(true)
  })

  it('refuses while a profile owner holds admission', async () => {
    const profile = fixture()
    const before = snapshot(profile)
    const admission = acquireProfileStateRuntimeAdmission(profile.root)
    try {
      expect(() => rollback(profile)).toThrow('in use')
      expect(snapshot(profile)).toEqual(before)
    } finally {
      admission.release()
    }
  })

  it('refuses an unresolved move without removing its journal', async () => {
    const profile = fixture()
    const before = snapshot(profile)
    const moves = join(profile.root, 'profile-move-intents')
    mkdirSync(moves)
    const journal = join(moves, '00000000-0000-0000-0000-000000000001.json')
    writeFileSync(journal, '{"partial":true}')
    expect(() => rollback(profile)).toThrow('pending project move')
    expect(snapshot(profile)).toEqual(before)
    expect(readFileSync(journal, 'utf8')).toBe('{"partial":true}')
  })
})
