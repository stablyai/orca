import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openProfileStateDatabase } from './profile-state-database'
import {
  hashProfileStateJson,
  importProfileStateJson,
  readProfileStateJsonAcceptance
} from './profile-state-documents'
import { ProfileStateSqliteAuthority } from './profile-state-sqlite-authority'
import { createProfileStateStore } from './profile-state-store-factory'

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpdir(),
    getName: () => 'orca-test',
    getVersion: () => '0.0.0-test',
    isPackaged: false,
    on: () => {},
    whenReady: () => Promise.resolve()
  },
  safeStorage: { isEncryptionAvailable: () => false },
  ipcMain: { on: () => {}, handle: () => {} },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../ssh/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

const fixtures: { directory: string; authority: ProfileStateSqliteAuthority }[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const { authority, directory } of fixtures.splice(0)) {
    authority.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'orca-json-compatibility-recovery-'))
  const paths = {
    dataFile: join(directory, 'orca-data.json'),
    databaseFile: join(directory, 'profile-state.db'),
    profileId: 'compatibility-recovery'
  }
  const retainedJson = '{"settings":{"theme":"light"}}'
  writeFileSync(paths.dataFile, retainedJson)
  const withDatabase = <T>(
    run: (db: ReturnType<typeof openProfileStateDatabase>['db']) => T
  ): T => {
    const opened = openProfileStateDatabase(paths.databaseFile, paths.profileId)
    try {
      return run(opened.db)
    } finally {
      opened.db.close()
    }
  }
  withDatabase((db) =>
    importProfileStateJson(db, retainedJson, {
      acceptedLegacyJsonHash: hashProfileStateJson(retainedJson)
    })
  )
  const authority = new ProfileStateSqliteAuthority(paths.databaseFile, paths.profileId)
  authority.readSerializedState()
  authority.writeSerializedState(Buffer.from('{"settings":{"theme":"dark"}}'))
  fixtures.push({ directory, authority })
  return {
    paths,
    authority,
    retainedJson,
    withDatabase,
    acceptance: () => withDatabase(readProfileStateJsonAcceptance),
    reopen: () => {
      const result = createProfileStateStore({ ...paths })
      try {
        expect(result.backend).toBe('sqlite')
        return result.store.getSettings().theme
      } finally {
        result.store.freezeWrites()
      }
    }
  }
}

describe('acceptance of snapshots left by earlier builds', () => {
  it.each(['retained', 'pending', 'promoted'] as const)(
    'opens SQLite with the %s JSON from a historical compatibility export',
    (phase) => {
      const state = fixture()
      const exportedJson = '{"settings":{"theme":"dark"}}'
      const next = { jsonHash: hashProfileStateJson(exportedJson), acceptedRevision: 2 }
      state.withDatabase((db) =>
        db.prepare('UPDATE profile_state_meta SET value = ? WHERE key = ?').run(
          JSON.stringify(
            phase === 'promoted'
              ? next
              : {
                  jsonHash: hashProfileStateJson(state.retainedJson),
                  acceptedRevision: 1,
                  pending: next
                }
          ),
          'legacy_json_acceptance'
        )
      )
      if (phase !== 'retained') {
        writeFileSync(state.paths.dataFile, exportedJson)
      }
      state.authority.writeSerializedState(Buffer.from('{"settings":{"theme":"system"}}'))
      const original = readFileSync(state.paths.dataFile, 'utf8')

      expect(state.reopen()).toBe('system')
      expect(readFileSync(state.paths.dataFile, 'utf8')).toBe(original)

      writeFileSync(state.paths.dataFile, '{"settings":{"theme":"light"},"externalEdit":true}')
      expect(state.reopen).toThrow('without a matching acceptance marker')
    }
  )
})

it.each([
  null,
  [],
  { jsonHash: 'invalid', acceptedRevision: 2 },
  { jsonHash: 'a'.repeat(64), acceptedRevision: 0 },
  { jsonHash: 'a'.repeat(64), acceptedRevision: 1.5 },
  { jsonHash: 'a'.repeat(64), acceptedRevision: 3 }
])('refuses malformed or impossible pending acceptance %#', (pending) => {
  const state = fixture()
  state.withDatabase((db) =>
    db.prepare('UPDATE profile_state_meta SET value = ? WHERE key = ?').run(
      JSON.stringify({
        jsonHash: hashProfileStateJson(state.retainedJson),
        acceptedRevision: 1,
        pending
      }),
      'legacy_json_acceptance'
    )
  )
  expect(state.reopen).toThrow()
  expect(readFileSync(state.paths.dataFile, 'utf8')).toBe(state.retainedJson)
})
