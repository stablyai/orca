import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as durableFiles from '../../durable-file-write'
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
    publish: async (mode: 'sync' | 'async') =>
      mode === 'sync'
        ? authority.writeJsonCompatibilityExport(paths.dataFile)
        : authority.writeJsonCompatibilityExportAsync(paths.dataFile),
    reopen: () => {
      const result = createProfileStateStore({ ...paths, authorityMode: 'sqlite-established' })
      try {
        expect(result.backend).toBe('sqlite')
        return result.store.getSettings().theme
      } finally {
        result.store.freezeWrites()
      }
    }
  }
}

describe.each(['sync', 'async'] as const)('%s compatibility export recovery', (mode) => {
  it.each(['staging', 'publication', 'promotion'] as const)(
    'reopens SQLite and permits a later export after failed %s',
    async (phase) => {
      const state = fixture()
      if (phase === 'publication') {
        if (mode === 'sync') {
          const write = durableFiles.writeFileDurableSync
          vi.spyOn(durableFiles, 'writeFileDurableSync').mockImplementation((...args) => {
            if (args[1] === state.paths.dataFile) {
              throw new Error('injected publication failure')
            }
            write(...args)
          })
        } else {
          vi.spyOn(durableFiles, 'writeFileDurable').mockRejectedValueOnce(
            new Error('injected publication failure')
          )
        }
      } else {
        state.withDatabase((db) =>
          db.exec(
            `CREATE TRIGGER reject_acceptance BEFORE INSERT ON profile_state_meta
           WHEN NEW.key = 'legacy_json_acceptance'
           ${phase === 'promotion' ? "AND json_type(NEW.value, '$.pending') IS NULL" : ''}
           BEGIN SELECT RAISE(ABORT, 'injected acceptance failure'); END`
          )
        )
      }

      await expect(state.publish(mode)).rejects.toThrow('injected')

      const published = readFileSync(state.paths.dataFile, 'utf8')
      expect(JSON.parse(published).settings.theme).toBe(phase === 'promotion' ? 'dark' : 'light')
      expect(state.reopen()).toBe('dark')
      if (phase !== 'staging') {
        expect(state.acceptance()?.pending).toEqual({
          jsonHash: hashProfileStateJson('{"settings":{"theme":"dark"}}'),
          acceptedRevision: 2
        })
      }
      vi.restoreAllMocks()
      state.withDatabase((db) => db.exec('DROP TRIGGER IF EXISTS reject_acceptance'))
      state.authority.writeSerializedState(Buffer.from('{"settings":{"theme":"system"}}'))

      await state.publish(mode)

      expect(state.reopen()).toBe('system')
      expect(state.acceptance()).toEqual({
        jsonHash: hashProfileStateJson(readFileSync(state.paths.dataFile, 'utf8')),
        acceptedRevision: 3
      })
    }
  )

  it('keeps the published JSON accepted when a concurrent commit prevents promotion', async () => {
    const state = fixture()
    const compete = () => {
      const other = new ProfileStateSqliteAuthority(state.paths.databaseFile, state.paths.profileId)
      try {
        other.readSerializedState()
        other.writeSerializedState(Buffer.from('{"settings":{"theme":"system"}}'))
      } finally {
        other.close()
      }
    }
    if (mode === 'sync') {
      const write = durableFiles.writeFileDurableSync
      vi.spyOn(durableFiles, 'writeFileDurableSync').mockImplementation((...args) => {
        write(...args)
        if (args[1] === state.paths.dataFile) {
          compete()
        }
      })
    } else {
      const write = durableFiles.writeFileDurable
      vi.spyOn(durableFiles, 'writeFileDurable').mockImplementationOnce(async (...args) => {
        await write(...args)
        compete()
      })
    }

    await expect(state.publish(mode)).rejects.toMatchObject({
      code: 'profile-state-revision-conflict'
    })

    expect(JSON.parse(readFileSync(state.paths.dataFile, 'utf8')).settings.theme).toBe('dark')
    expect(state.reopen()).toBe('system')
    expect(state.acceptance()?.pending?.acceptedRevision).toBe(2)
  })

  it('refuses an unrelated edit even while a previous export remains staged', async () => {
    const state = fixture()
    if (mode === 'sync') {
      const write = durableFiles.writeFileDurableSync
      vi.spyOn(durableFiles, 'writeFileDurableSync').mockImplementation((...args) => {
        if (args[1] === state.paths.dataFile) {
          throw new Error('injected publication failure')
        }
        write(...args)
      })
    } else {
      vi.spyOn(durableFiles, 'writeFileDurable').mockRejectedValueOnce(
        new Error('injected publication failure')
      )
    }
    await expect(state.publish(mode)).rejects.toThrow('injected')
    expect(state.acceptance()?.pending).toEqual({
      jsonHash: hashProfileStateJson('{"settings":{"theme":"dark"}}'),
      acceptedRevision: 2
    })
    const unrelatedJson = '{"settings":{"theme":"system"},"unrelatedEdit":true}'
    writeFileSync(state.paths.dataFile, unrelatedJson)

    expect(state.reopen).toThrow('without a matching acceptance marker')
    await expect(state.publish(mode)).rejects.toThrow('Compatibility JSON changed before export')
    expect(readFileSync(state.paths.dataFile, 'utf8')).toBe(unrelatedJson)
  })
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
  expect(() => state.authority.writeJsonCompatibilityExport(state.paths.dataFile)).toThrow()
  expect(readFileSync(state.paths.dataFile, 'utf8')).toBe(state.retainedJson)
})
