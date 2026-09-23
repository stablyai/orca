import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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

function rollback(profile: Awaited<ReturnType<typeof fixture>>): Promise<void> {
  const handler = PROFILE_STATE_HANDLERS['profile state rollback']
  if (handler === undefined) {
    throw new Error('Profile rollback handler is missing')
  }
  return handler({
    flags: new Map([['backup', profile.backupId]]),
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
  it('refuses recovery before any mutation when a runtime has already entered', async () => {
    const profile = await fixture()
    const original = readFileSync(profile.databasePath)
    const backup = readFileSync(profile.backupPath)
    const admission = acquireProfileStateRuntimeAdmission(profile.root)
    const runtime = openProfileStateDatabase(profile.databasePath, profileId)
    try {
      await expect(rollback(profile)).rejects.toThrow('in use')
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
  })

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
