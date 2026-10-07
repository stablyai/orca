import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as durableFileWrite from '../../main/durable-file-write'
import {
  acquireProfileStateMaintenance,
  acquireProfileStateRuntimeAdmission
} from '../../main/persistence/profile-state/profile-state-access'
import {
  openProfileStateDatabase,
  openProfileStateDatabaseReadOnly
} from '../../main/persistence/profile-state/profile-state-database'
import {
  importProfileStateJson,
  readProfileStateSnapshot
} from '../../main/persistence/profile-state/profile-state-documents'
import {
  createProfileStateDatabaseBackupId,
  profileStateDatabaseBackupPath
} from '../../main/persistence/profile-state/profile-state-backup-path'
import { writeProfileStateDatabaseSnapshotAsync } from '../../main/persistence/profile-state/profile-state-database-snapshot'
import { restoreProfileStateDatabaseBackup } from '../../main/persistence/profile-state/profile-state-database-recovery'
import {
  assertNoRetainedProfileStateExports,
  ProfileStateRecoveryRequiredError
} from '../../main/persistence/profile-state/profile-state-recovery-required'
import { RuntimeClient } from '../runtime-client'
import { PROFILE_STATE_HANDLERS } from './profile-state'
import { rollbackProfileState } from '../../main/persistence/profile-state/profile-state-recovery-command'
import { profileStateJsonExportPath } from '../../main/persistence/profile-state/legacy-json/profile-state-export-path'

const mocks = vi.hoisted(() => ({ root: vi.fn(), status: vi.fn() }))
vi.mock('../runtime-client', () => ({
  getDefaultUserDataPath: mocks.root,
  RuntimeClient: class {
    getCliStatus = mocks.status
  },
  RuntimeClientError: class extends Error {
    constructor(
      readonly code: string,
      message: string
    ) {
      super(message)
    }
  }
}))

const roots: string[] = []
const profileId = 'admission-recovery'
const backupState = {
  settings: {
    theme: 'restored',
    httpProxyUrl: 'sealed:backup',
    electronHttp1CompatibilityMode: true
  },
  extension: { unknown: [null, '\ud800', 'backup'] },
  opaque: null
}
const liveState = {
  settings: { theme: 'runtime-before-restore', httpProxyUrl: 'sealed:live' },
  extension: { unknown: [null, '\ud800', 'live'] },
  opaque: null
}

beforeEach(() => {
  mocks.status.mockReset().mockResolvedValue({
    result: { app: { running: false }, runtime: { reachable: false } }
  })
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'orca-recovery-admission-'))
  roots.push(root)
  const directory = join(root, 'profiles', profileId)
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    join(root, 'orca-profile-index.json'),
    JSON.stringify({ activeProfileId: profileId, profiles: [{ id: profileId }] })
  )
  const databasePath = join(directory, 'profile-state.db')
  const dataFile = join(directory, 'orca-data.json')
  const backupId = createProfileStateDatabaseBackupId()
  const backupPath = profileStateDatabaseBackupPath(databasePath, backupId)
  const source = openProfileStateDatabase(databasePath, profileId)
  try {
    importProfileStateJson(source.db, JSON.stringify(backupState))
    await writeProfileStateDatabaseSnapshotAsync(source.db, backupPath)
    importProfileStateJson(source.db, JSON.stringify(liveState), { expectedRevision: 1 })
  } finally {
    source.db.close()
  }
  mocks.root.mockReturnValue(root)
  return { root, directory, databasePath, dataFile, backupId, backupPath }
}

function rollback(
  profile: Awaited<ReturnType<typeof fixture>>,
  selector: 'backup' | 'latest-json' = 'backup'
): Promise<void> {
  const handler = PROFILE_STATE_HANDLERS['profile state rollback']
  if (handler === undefined) {
    throw new Error('Profile rollback handler is missing')
  }
  return handler({
    flags: new Map<string, string | boolean>([
      [selector, selector === 'backup' ? profile.backupId : true]
    ]),
    client: new RuntimeClient(profile.root),
    cwd: profile.root,
    json: true
  })
}

function state(databasePath: string) {
  const opened = openProfileStateDatabaseReadOnly(databasePath, profileId)
  try {
    return readProfileStateSnapshot(opened.db)
  } finally {
    opened.db.close()
  }
}

describe('offline recovery excludes runtime admission', () => {
  it.each(['backup', 'latest-json'] as const)(
    'refuses %s rollback without changing the database when a move journal is unresolved',
    async (selector) => {
      const profile = await fixture()
      const before = readFileSync(profile.databasePath)
      const intents = join(profile.root, 'profile-move-intents')
      mkdirSync(intents)
      const intentPath = join(intents, '00000000-0000-0000-0000-000000000001.json')
      writeFileSync(intentPath, '{"partial":true}')
      await expect(rollback(profile, selector)).rejects.toThrow('pending project move')
      expect(readFileSync(profile.databasePath)).toEqual(before)
      expect(readFileSync(intentPath, 'utf8')).toBe('{"partial":true}')
    }
  )

  it.each(['backup', 'latest-json'] as const)(
    'refuses %s recovery before any mutation when a runtime has already entered',
    async (selector) => {
      const profile = await fixture()
      const original = readFileSync(profile.databasePath)
      const backup = readFileSync(profile.backupPath)
      const admission = acquireProfileStateRuntimeAdmission(profile.root)
      const runtime = openProfileStateDatabase(profile.databasePath, profileId)
      try {
        await expect(rollback(profile, selector)).rejects.toThrow('in use')
        expect(mocks.status).not.toHaveBeenCalled()
        expect(JSON.parse(readProfileStateSnapshot(runtime.db).json)).toEqual(liveState)
        expect(readFileSync(profile.databasePath)).toEqual(original)
        expect(readFileSync(profile.backupPath)).toEqual(backup)
        expect(
          readdirSync(profile.directory).some((name) => name.startsWith('profile-state-corrupt'))
        ).toBe(false)
      } finally {
        runtime.db.close()
        admission.release()
      }
    }
  )

  it('exports the latest SQLite revision through CLI before handing authority to an older build', async () => {
    const profile = await fixture()
    const staleJson = JSON.stringify(backupState)
    writeFileSync(profile.dataFile, staleJson)
    const original = readFileSync(profile.databasePath)
    mocks.status.mockImplementation(async () => {
      expect(() => acquireProfileStateRuntimeAdmission(profile.root)).toThrow('in use')
      return { result: { app: { running: false }, runtime: { reachable: false } } }
    })

    await rollback(profile, 'latest-json')

    expect(JSON.parse(readFileSync(profile.dataFile, 'utf8'))).toEqual(liveState)
    expect(existsSync(profile.databasePath)).toBe(false)
    expect(existsSync(profile.backupPath)).toBe(false)
    const output: unknown = JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0]))
    expect(output).toMatchObject({ ok: true, result: { revision: 2, storage: 'json' } })
    const quarantine = readdirSync(profile.directory).find((name) =>
      name.startsWith('profile-state-corrupt')
    )
    if (!quarantine) {
      throw new Error('Latest JSON handoff did not preserve original state')
    }
    const archived = join(profile.directory, quarantine)
    expect(readFileSync(join(archived, 'profile-state.db'))).toEqual(original)
    expect(readFileSync(join(archived, 'orca-data.json'), 'utf8')).toBe(staleJson)
    expect(
      JSON.parse(readFileSync(join(archived, 'orca-data.json.sqlite-export.2.json'), 'utf8'))
    ).toEqual(liveState)
    acquireProfileStateRuntimeAdmission(profile.root).release()
  })

  it.each([false, true])(
    'preserves all prior exports before archival (failure: %s)',
    async (failArchive) => {
      const profile = await fixture()
      const opened = openProfileStateDatabase(profile.databasePath, profileId)
      try {
        for (let revision = 3; revision <= 6; revision++) {
          importProfileStateJson(opened.db, JSON.stringify(liveState), {
            expectedRevision: revision - 1
          })
        }
      } finally {
        opened.db.close()
      }
      const retained = Array.from({ length: 5 }, (_, i) => ({
        path: profileStateJsonExportPath(profile.dataFile, i + 1),
        content: JSON.stringify({ ...backupState, retainedRevision: i + 1 })
      }))
      for (const entry of retained) {
        writeFileSync(entry.path, entry.content)
      }
      if (failArchive) {
        const write = durableFileWrite.writeFileDurableSync
        vi.spyOn(durableFileWrite, 'writeFileDurableSync').mockImplementation((...args) => {
          if (args[1].endsWith('manifest.json')) {
            throw new Error('injected archive failure')
          }
          write(...args)
        })
        await expect(rollback(profile, 'latest-json')).rejects.toThrow('injected archive failure')
        for (const entry of retained) {
          expect(readFileSync(entry.path, 'utf8')).toBe(entry.content)
        }
        expect(JSON.parse(state(profile.databasePath).json)).toEqual(liveState)
      } else {
        await rollback(profile, 'latest-json')
        const archive = readdirSync(profile.directory).find((name) =>
          name.startsWith('profile-state-corrupt')
        )
        if (!archive) {
          throw new Error('Recovery archive missing')
        }
        for (let revision = 1; revision <= 5; revision++) {
          expect(
            readFileSync(
              join(profile.directory, archive, `orca-data.json.sqlite-export.${revision}.json`),
              'utf8'
            )
          ).toBe(retained[revision - 1].content)
        }
        expect(JSON.parse(readFileSync(profile.dataFile, 'utf8'))).toEqual(liveState)
      }
    }
  )

  it('leaves canonical JSON and SQLite untouched when the latest export cannot be published', async () => {
    const profile = await fixture()
    writeFileSync(profile.dataFile, JSON.stringify(backupState))
    const before = [profile.dataFile, profile.databasePath, profile.backupPath].map((file) =>
      readFileSync(file)
    )
    mkdirSync(profileStateJsonExportPath(profile.dataFile, 2))

    await expect(rollback(profile, 'latest-json')).rejects.toThrow()

    expect(
      [profile.dataFile, profile.databasePath, profile.backupPath].map((file) => readFileSync(file))
    ).toEqual(before)
    expect(
      readdirSync(profile.directory).some((name) => name.startsWith('profile-state-corrupt'))
    ).toBe(false)
    acquireProfileStateRuntimeAdmission(profile.root).release()
  })

  it('rejects fabricated or released maintenance before creating the latest export', async () => {
    const profile = await fixture()
    const maintenance = acquireProfileStateMaintenance(profile.root)
    try {
      expect(() =>
        rollbackProfileState(profile.root, { kind: 'latest-json' }, { ...maintenance })
      ).toThrow('acquired')
    } finally {
      maintenance.release()
    }
    expect(() => rollbackProfileState(profile.root, { kind: 'latest-json' }, maintenance)).toThrow(
      'released'
    )
    expect(existsSync(profileStateJsonExportPath(profile.dataFile, 2))).toBe(false)
    expect(JSON.parse(state(profile.databasePath).json)).toEqual(liveState)
  })

  it.each(['missing', 'corrupt', 'newer-schema'] as const)(
    'refuses a latest JSON handoff from a %s database instead of selecting stale JSON',
    async (condition) => {
      const profile = await fixture()
      const staleJson = JSON.stringify(backupState)
      writeFileSync(profile.dataFile, staleJson)
      if (condition === 'missing') {
        rmSync(profile.databasePath)
      } else if (condition === 'corrupt') {
        writeFileSync(profile.databasePath, 'corrupt SQLite')
      } else {
        const opened = openProfileStateDatabase(profile.databasePath, profileId)
        opened.db.pragma('user_version = 999')
        opened.db.close()
      }
      const before = existsSync(profile.databasePath)
        ? readFileSync(profile.databasePath)
        : undefined

      await expect(rollback(profile, 'latest-json')).rejects.toThrow()

      expect(readFileSync(profile.dataFile, 'utf8')).toBe(staleJson)
      expect(
        existsSync(profile.databasePath) ? readFileSync(profile.databasePath) : undefined
      ).toEqual(before)
      expect(existsSync(profile.backupPath)).toBe(true)
      expect(existsSync(profileStateJsonExportPath(profile.dataFile, 2))).toBe(false)
      expect(
        readdirSync(profile.directory).some((name) => name.startsWith('profile-state-corrupt'))
      ).toBe(false)
    }
  )

  it('blocks startup between the stopped census and restoration while preserving complete original and restored state', async () => {
    const profile = await fixture()
    const original = readFileSync(profile.databasePath)
    const backup = readFileSync(profile.backupPath)
    mocks.status.mockImplementation(async () => {
      const stopped = { result: { app: { running: false }, runtime: { reachable: false } } }
      expect(() => acquireProfileStateRuntimeAdmission(profile.root)).toThrow('in use')
      expect(() => acquireProfileStateMaintenance(profile.root)).toThrow('in use')
      return stopped
    })

    await rollback(profile)

    expect(mocks.status).toHaveBeenCalledOnce()
    expect(JSON.parse(state(profile.databasePath).json)).toEqual(backupState)
    expect(readFileSync(profile.backupPath)).toEqual(backup)
    const quarantine = readdirSync(profile.directory).find((name) =>
      name.startsWith('profile-state-corrupt')
    )
    expect(quarantine).toBeDefined()
    if (quarantine === undefined) {
      throw new Error('Recovery did not preserve a quarantine')
    }
    const quarantined = join(profile.directory, quarantine, 'profile-state.db')
    expect(readFileSync(quarantined)).toEqual(original)
    expect(JSON.parse(state(quarantined).json)).toEqual(liveState)
    const admission = acquireProfileStateRuntimeAdmission(profile.root)
    expect(JSON.parse(state(profile.databasePath).json)).toEqual(backupState)
    admission.release()
  })

  it('keeps startup blocked after failed durable publication and permits an explicit successful retry', async () => {
    const profile = await fixture()
    const backup = readFileSync(profile.backupPath)
    const rename = durableFileWrite.renameDurableSync
    const failure = vi
      .spyOn(durableFileWrite, 'renameDurableSync')
      .mockImplementation((from, to) => {
        if (to === profile.databasePath) {
          throw new Error('injected recovery publication failure')
        }
        rename(from, to)
      })
    await expect(rollback(profile)).rejects.toThrow('injected recovery publication failure')
    const admission = acquireProfileStateRuntimeAdmission(profile.root)
    try {
      expect(() =>
        assertNoRetainedProfileStateExports({
          dataFile: profile.dataFile,
          databaseFile: profile.databasePath,
          profileId
        })
      ).toThrow(ProfileStateRecoveryRequiredError)
    } finally {
      admission.release()
    }
    expect(readFileSync(profile.backupPath)).toEqual(backup)
    const quarantine = readdirSync(profile.directory).find((name) =>
      name.startsWith('profile-state-corrupt')
    )
    if (quarantine === undefined) {
      throw new Error('Recovery did not preserve original state')
    }
    expect(JSON.parse(state(join(profile.directory, quarantine, 'profile-state.db')).json)).toEqual(
      liveState
    )

    failure.mockRestore()
    await rollback(profile)

    expect(JSON.parse(state(profile.databasePath).json)).toEqual(backupState)
    acquireProfileStateRuntimeAdmission(profile.root).release()
  })

  it('rejects fabricated or released maintenance handles before replacing any database bytes', async () => {
    const profile = await fixture()
    const maintenance = acquireProfileStateMaintenance(profile.root)
    const original = readFileSync(profile.databasePath)
    const options = { ...profile, profileId }
    expect(() =>
      restoreProfileStateDatabaseBackup({ ...options, maintenance: { ...maintenance } })
    ).toThrow('acquired')
    maintenance.release()
    expect(() => restoreProfileStateDatabaseBackup({ ...options, maintenance })).toThrow('released')
    expect(readFileSync(profile.databasePath)).toEqual(original)
  })
})
