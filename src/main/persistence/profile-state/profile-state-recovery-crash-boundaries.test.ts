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
import { basename, dirname, join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { setSecretStore } from '../../../shared/secret-store'
import { profileStateStorage } from '../../orca-profiles/profile-project-state-file'
import {
  acquireProfileStateMaintenance,
  acquireProfileStateRuntimeAdmission
} from './profile-state-access'
import {
  openProfileStateDatabase,
  openProfileStateDatabaseReadOnly
} from './profile-state-database'
import {
  hashProfileStateJson,
  importProfileStateJson,
  readProfileStateSnapshot
} from './profile-state-documents'
import {
  profileStateJsonExportPath,
  profileStateJsonExportPaths
} from './legacy-json/profile-state-export-path'
import {
  createProfileStateDatabaseBackupId,
  profileStateDatabaseBackupPath,
  profileStateDatabaseBackups
} from './profile-state-backup-path'
import { writeProfileStateDatabaseSnapshotAsync } from './profile-state-database-snapshot'
import { createProfileStateStore } from './profile-state-store-factory'
import { restoreProfileStateJsonExport } from './legacy-json/profile-state-recovery'
import { restoreProfileStateDatabaseBackup } from './profile-state-database-recovery'
import {
  buildRecoveryCrashProcess,
  killRecoveryAt,
  type RecoveryCrashOptions
} from './profile-state-recovery-crash-process'

vi.mock('../../telemetry/client', () => ({ track: () => {} }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../ssh/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

const suiteRoot = mkdtempSync(join(tmpdir(), 'orca-recovery-crash-boundaries-'))
const fixtureRoots: string[] = []
let bundle: string
const profileId = 'crash-recovery'
const selectedState = {
  settings: {
    theme: 'dark',
    httpProxyUrl: Buffer.from('sealed-selected').toString('base64'),
    electronHttp1CompatibilityMode: true
  },
  ui: { extension: { origin: 'selected', value: null } },
  extension: { nested: [null, '\ud800', 'selected'], ['__proto__']: { inert: true } },
  opaque: null,
  repos: [],
  automationRuns: [],
  automations: []
}
const oldState = {
  ...selectedState,
  settings: {
    ...selectedState.settings,
    theme: 'light',
    httpProxyUrl: Buffer.from('sealed-old').toString('base64')
  },
  ui: { extension: { origin: 'old', value: null } },
  extension: { nested: [null, '\ud800', 'old'], ['__proto__']: { inert: true } }
}
const selectedJson = JSON.stringify(selectedState)
const oldJson = JSON.stringify(oldState)

beforeAll(() => {
  bundle = buildRecoveryCrashProcess(suiteRoot)
})
beforeEach(() => {
  setSecretStore({
    isEncryptionAvailable: () => false,
    encryptString: () => {
      throw new Error('Keychain unavailable')
    },
    decryptString: () => {
      throw new Error('Keychain unavailable')
    },
    describeProtectionGap: () => null
  })
})
afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})
afterAll(() => rmSync(suiteRoot, { recursive: true, force: true }))

type Fixture = RecoveryCrashOptions & { backupBytes: Buffer; originalFamily: Map<string, Buffer> }

async function fixture(kind: 'json' | 'sqlite', accepted: boolean): Promise<Fixture> {
  const root = mkdtempSync(join(suiteRoot, 'profile-'))
  fixtureRoots.push(root)
  const directory = join(root, 'profiles', profileId)
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    join(root, 'orca-profile-index.json'),
    JSON.stringify({ activeProfileId: profileId, profiles: [{ id: profileId }] })
  )
  const dataFile = join(directory, 'orca-data.json')
  const databasePath = join(directory, 'profile-state.db')
  const exportPath = profileStateJsonExportPath(dataFile, 3)
  const backupPath = profileStateDatabaseBackupPath(
    databasePath,
    createProfileStateDatabaseBackupId()
  )
  const options = {
    root,
    profileId,
    dataFile,
    databasePath,
    exportPath,
    backupPath,
    markerPath: join(root, 'http1-compatibility.json'),
    kind
  }
  const source = openProfileStateDatabase(databasePath, profileId)
  try {
    importProfileStateJson(source.db, oldJson)
    importProfileStateJson(source.db, oldJson)
    importProfileStateJson(
      source.db,
      selectedJson,
      accepted ? { acceptedLegacyJsonHash: hashProfileStateJson(selectedJson) } : {}
    )
    await writeProfileStateDatabaseSnapshotAsync(source.db, backupPath)
  } finally {
    source.db.close()
  }
  await killRecoveryAt(bundle, options, 'seed', oldJson)
  expect(existsSync(`${databasePath}-wal`)).toBe(true)
  expect(existsSync(`${databasePath}-shm`)).toBe(true)
  // An empty abandoned rollback journal is harmless, but must be removed before publication.
  writeFileSync(`${databasePath}-journal`, '')
  if (accepted) {
    writeFileSync(dataFile, selectedJson)
  }
  writeFileSync(exportPath, selectedJson)
  writeFileSync(
    profileStateJsonExportPath(dataFile, 1),
    JSON.stringify({ ...oldState, exportRevision: 1 })
  )
  writeFileSync(
    profileStateJsonExportPath(dataFile, 2),
    JSON.stringify({ ...oldState, exportRevision: 2 })
  )
  writeFileSync(options.markerPath, JSON.stringify({ schemeVersion: 2, enabled: false, profileId }))
  const originalFamily = new Map(
    ['', '-wal', '-shm', '-journal'].map((suffix) => [
      suffix,
      readFileSync(`${databasePath}${suffix}`)
    ])
  )
  return { ...options, backupBytes: readFileSync(backupPath), originalFamily }
}

function readSqlite(path: string): unknown {
  const opened = openProfileStateDatabaseReadOnly(path, profileId)
  try {
    return JSON.parse(readProfileStateSnapshot(opened.db).json)
  } finally {
    opened.db.close()
  }
}

function assertQuarantine(profile: Fixture): void {
  const quarantine = readdirSync(dirname(profile.databasePath)).find((name) =>
    name.startsWith('profile-state-corrupt-')
  )
  if (quarantine === undefined) {
    throw new Error('Recovery did not preserve a quarantine')
  }
  const directory = join(dirname(profile.databasePath), quarantine)
  // Check exact family bytes before opening the copied WAL snapshot.
  for (const [suffix, bytes] of profile.originalFamily) {
    expect(readFileSync(join(directory, `profile-state.db${suffix}`))).toEqual(bytes)
  }
  expect(readFileSync(join(directory, basename(profile.exportPath)), 'utf8')).toBe(selectedJson)
  expect(readFileSync(join(directory, basename(profile.backupPath)))).toEqual(profile.backupBytes)
  expect(readSqlite(join(directory, 'profile-state.db'))).toEqual(oldState)
}

function assertRestart(profile: Fixture, expected: 'old' | 'selected' | 'refused'): void {
  const admission = acquireProfileStateRuntimeAdmission(profile.root)
  try {
    const open = () =>
      createProfileStateStore({
        dataFile: profile.dataFile,
        databaseFile: profile.databasePath,
        profileId
      })
    if (expected === 'refused') {
      expect(open).toThrow()
      expect(() => profileStateStorage(profileId, profile.root)).toThrow()
      return
    }
    const expectedState = expected === 'old' ? oldState : selectedState
    const storage = profileStateStorage(profileId, profile.root)
    const raw =
      storage === 'sqlite'
        ? readSqlite(profile.databasePath)
        : JSON.parse(readFileSync(profile.dataFile, 'utf8'))
    // Full raw-state equality is checked before Store normalization can hide a lost domain.
    expect(raw).toEqual(expectedState)
    const reopened = open()
    try {
      expect(reopened.backend).toBe('sqlite')
      expect(reopened.migrated).toBe(storage === 'json')
      expect(profileStateStorage(profileId, profile.root)).toBe('sqlite')
      const projected: unknown = JSON.parse(reopened.store.prepareProfileStateExport().json)
      expect(projected).toMatchObject(expectedState)
    } finally {
      reopened.store.freezeWrites()
    }
  } finally {
    admission.release()
  }
}

function retry(profile: Fixture): void {
  const maintenance = acquireProfileStateMaintenance(profile.root)
  try {
    if (profile.kind === 'json') {
      expect(profileStateJsonExportPaths(profile.dataFile)).toContain(profile.exportPath)
      restoreProfileStateJsonExport({ ...profile, maintenance })
    } else {
      expect(
        profileStateDatabaseBackups(profile.databasePath).some(
          (backup) => backup.path === profile.backupPath
        )
      ).toBe(true)
      restoreProfileStateDatabaseBackup({ ...profile, maintenance })
    }
  } finally {
    maintenance.release()
  }
  assertRestart(profile, 'selected')
}

const JSON_BOUNDARIES = [
  'marker-invalidated',
  'json-publish:before',
  'json-publish:after',
  'primary',
  'wal',
  'shm',
  'journal',
  'other-export',
  'first-export',
  'backup',
  'selected-export',
  'restore-returned',
  'marker-publish:before',
  'marker-publish:after',
  'marker-refreshed'
] as const

function stage(profile: Fixture, name: string): string {
  const paths: Record<string, string> = {
    primary: profile.databasePath,
    wal: `${profile.databasePath}-wal`,
    shm: `${profile.databasePath}-shm`,
    journal: `${profile.databasePath}-journal`,
    'other-export': profileStateJsonExportPath(profile.dataFile, 2),
    'first-export': profileStateJsonExportPath(profile.dataFile, 1),
    'marker-invalidated': profile.markerPath,
    backup: profile.backupPath,
    'selected-export': profile.exportPath,
    json: profile.dataFile
  }
  const target = paths[name]
  return target === undefined ? name : `removed:${target}`
}

describe.each([false, true])('JSON recovery process death, accepted prior JSON=%s', (accepted) => {
  it.each(JSON_BOUNDARIES)(
    'preserves a complete authority or exact retry at %s',
    async (boundary) => {
      const profile = await fixture('json', accepted)
      await killRecoveryAt(bundle, profile, stage(profile, boundary))
      assertQuarantine(profile)
      const finished = [
        'selected-export',
        'restore-returned',
        'marker-publish:before',
        'marker-publish:after',
        'marker-refreshed'
      ].includes(boundary)
      const expected = finished
        ? 'selected'
        : ['marker-invalidated', 'json-publish:before'].includes(boundary) ||
            (boundary === 'json-publish:after' && accepted)
          ? 'old'
          : 'refused'
      if (finished) {
        expect(readFileSync(profile.dataFile, 'utf8')).toBe(selectedJson)
        expect(profileStateJsonExportPaths(profile.dataFile)).toEqual([])
        expect(profileStateDatabaseBackups(profile.databasePath)).toEqual([])
      }
      assertRestart(profile, expected)
      if (!finished) {
        expect(readFileSync(profile.exportPath, 'utf8')).toBe(selectedJson)
        retry(profile)
      }
    }
  )
})

describe('SQLite recovery process death', () => {
  it.each([
    'marker-invalidated',
    'selected-export',
    'other-export',
    'first-export',
    'primary',
    'wal',
    'shm',
    'journal',
    'json',
    'sqlite-publish:before',
    'sqlite-publish:after',
    'restore-returned',
    'marker-publish:before',
    'marker-publish:after',
    'marker-refreshed'
  ])('preserves full state and its immutable retry backup at %s', async (boundary) => {
    const profile = await fixture('sqlite', true)
    await killRecoveryAt(bundle, profile, stage(profile, boundary))
    assertQuarantine(profile)
    expect(readFileSync(profile.backupPath)).toEqual(profile.backupBytes)
    const expected = [
      'marker-invalidated',
      'selected-export',
      'other-export',
      'first-export'
    ].includes(boundary)
      ? 'old'
      : [
            'sqlite-publish:after',
            'restore-returned',
            'marker-publish:before',
            'marker-publish:after',
            'marker-refreshed'
          ].includes(boundary)
        ? 'selected'
        : 'refused'
    assertRestart(profile, expected)
    retry(profile)
    expect(readFileSync(profile.backupPath)).toEqual(profile.backupBytes)
  })

  it.skipIf(process.platform === 'win32')(
    'allows clean JSON startup after final artifact cleanup is directory-synced',
    async () => {
      const profile = await fixture('json', true)
      await killRecoveryAt(bundle, profile, 'cleanup-directory-synced')
      assertQuarantine(profile)
      assertRestart(profile, 'selected')
    }
  )
})
