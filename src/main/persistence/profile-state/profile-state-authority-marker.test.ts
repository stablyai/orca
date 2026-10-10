import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as durableFileWrite from '../../durable-file-write'
import { bootstrapProfileStateAuthority } from './profile-state-authority-bootstrap'
import {
  hasProfileStateAuthorityMarker,
  profileStateAuthorityMarkerPath
} from './profile-state-authority-marker'
import {
  openProfileStateDatabase,
  openProfileStateDatabaseReadOnly
} from './profile-state-database'
import { importProfileStateJson, readProfileStateSnapshot } from './profile-state-documents'
import { profileStateDatabaseFiles } from './profile-state-storage-classification'
import { profileStateJsonExportPaths } from './legacy-json/profile-state-export-path'
import { ProfileStateRecoveryRequiredError } from './profile-state-recovery-required'
import { ProfileStateSqliteAuthority } from './profile-state-sqlite-authority'

vi.mock('node:fs', async (original) => ({ ...(await original<typeof fs>()) }))
vi.mock('../../telemetry/client', () => ({ track: () => {} }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../ssh/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

const source = JSON.stringify({ settings: { theme: 'dark' }, extension: { original: true } })
const current = JSON.stringify({ settings: { theme: 'light' }, extension: { acknowledged: true } })

function fixture(kind: 'empty' | 'json' | 'sqlite') {
  const root = fs.mkdtempSync(join(tmpdir(), 'orca-authority-marker-'))
  roots.push(root)
  const options = {
    dataFile: join(root, 'orca-data.json'),
    databaseFile: join(root, 'profile-state.db'),
    profileId: 'marker-profile',
    allowEmptyProfileState: true
  }
  if (kind === 'json') {
    fs.writeFileSync(options.dataFile, source)
  }
  if (kind === 'sqlite') {
    const opened = openProfileStateDatabase(options.databaseFile, options.profileId)
    try {
      importProfileStateJson(opened.db, source)
    } finally {
      opened.db.close()
    }
  }
  return options
}

function readSqlite(options: ReturnType<typeof fixture>): string {
  const opened = openProfileStateDatabaseReadOnly(options.databaseFile, options.profileId)
  try {
    return readProfileStateSnapshot(opened.db).json
  } finally {
    opened.db.close()
  }
}

describe.each(['empty', 'json', 'sqlite'] as const)('%s profile authority evidence', (kind) => {
  it.each([false, true])('refuses missing SQLite with stale JSON present=%s', (hasJson) => {
    const options = fixture(kind)
    const initial = bootstrapProfileStateAuthority(options)
    if (!initial.authority) {
      throw new Error('Fixture requires SQLite')
    }
    try {
      expect(hasProfileStateAuthorityMarker(options.databaseFile)).toBe(true)
      initial.authority.writeSerializedState(Buffer.from(current))
    } finally {
      initial.authority.close()
    }
    for (const path of [
      ...profileStateDatabaseFiles(options.databaseFile),
      ...profileStateJsonExportPaths(options.dataFile)
    ]) {
      fs.rmSync(path, { force: true })
    }
    if (hasJson) {
      fs.writeFileSync(options.dataFile, source)
    } else {
      fs.rmSync(options.dataFile, { force: true })
    }

    expect(() => bootstrapProfileStateAuthority(options)).toThrow(ProfileStateRecoveryRequiredError)
    expect(fs.existsSync(options.databaseFile)).toBe(false)
    expect(fs.existsSync(options.dataFile)).toBe(hasJson)
    if (hasJson) {
      expect(fs.readFileSync(options.dataFile, 'utf8')).toBe(source)
    }
  })

  it('refuses admission when marker publication fails and reopens the complete database on retry', () => {
    const options = fixture(kind)
    const write = durableFileWrite.writeFileDurableSync
    const injected = vi
      .spyOn(durableFileWrite, 'writeFileDurableSync')
      .mockImplementation((temporary, target, payload) => {
        if (target === profileStateAuthorityMarkerPath(options.databaseFile)) {
          throw new Error('marker publication failed')
        }
        return write(temporary, target, payload)
      })
    expect(() => bootstrapProfileStateAuthority(options)).toThrow()
    expect(fs.existsSync(options.databaseFile)).toBe(true)
    expect(hasProfileStateAuthorityMarker(options.databaseFile)).toBe(false)
    const published = readSqlite(options)
    injected.mockRestore()

    const retry = bootstrapProfileStateAuthority(options)
    try {
      expect(retry.migrated).toBe(false)
      expect(hasProfileStateAuthorityMarker(options.databaseFile)).toBe(true)
      expect(readSqlite(options)).toBe(published)
    } finally {
      retry.authority?.close()
    }
  })
})

it('does not rewrite authority evidence during saves or reopen', () => {
  const options = fixture('empty')
  const write = vi.spyOn(durableFileWrite, 'writeFileDurableSync')
  const initial = bootstrapProfileStateAuthority(options)
  try {
    initial.authority?.writeSerializedState(Buffer.from(source))
    initial.authority?.writeSerializedState(Buffer.from(current))
  } finally {
    initial.authority?.close()
  }
  bootstrapProfileStateAuthority(options).authority?.close()
  expect(
    write.mock.calls.filter(
      ([, target]) => target === profileStateAuthorityMarkerPath(options.databaseFile)
    )
  ).toHaveLength(1)
})

it('refuses direct authority writes before their marker is durable', () => {
  const options = fixture('sqlite')
  const write = durableFileWrite.writeFileDurableSync
  const injected = vi
    .spyOn(durableFileWrite, 'writeFileDurableSync')
    .mockImplementation((temporary, target, payload) => {
      if (target === profileStateAuthorityMarkerPath(options.databaseFile)) {
        throw new Error('marker publication failed')
      }
      return write(temporary, target, payload)
    })
  const authority = new ProfileStateSqliteAuthority(options.databaseFile, options.profileId)
  try {
    expect(() => authority.writeSerializedState(Buffer.from(current))).toThrow(
      'marker publication failed'
    )
    expect(readSqlite(options)).toBe(source)
    injected.mockRestore()
    authority.writeSerializedState(Buffer.from(current))
    expect(readSqlite(options)).toBe(current)
    expect(hasProfileStateAuthorityMarker(options.databaseFile)).toBe(true)
  } finally {
    authority.close()
  }
})

it('does not recreate an established database through a direct authority after its files are lost', () => {
  const options = fixture('sqlite')
  bootstrapProfileStateAuthority(options).authority?.close()
  for (const path of profileStateDatabaseFiles(options.databaseFile)) {
    fs.rmSync(path, { force: true })
  }
  const authority = new ProfileStateSqliteAuthority(options.databaseFile, options.profileId)
  try {
    expect(() => authority.writeSerializedState(Buffer.from(current))).toThrow()
    expect(fs.existsSync(options.databaseFile)).toBe(false)
    expect(hasProfileStateAuthorityMarker(options.databaseFile)).toBe(true)
  } finally {
    authority.close()
  }
})

it.each(['unknown-content', 'directory'] as const)(
  'treats %s at the marker path as authority evidence',
  (kind) => {
    const options = fixture('json')
    const path = profileStateAuthorityMarkerPath(options.databaseFile)
    if (kind === 'directory') {
      fs.mkdirSync(path)
    } else {
      fs.writeFileSync(path, 'future authority evidence')
    }
    expect(() => bootstrapProfileStateAuthority(options)).toThrow(ProfileStateRecoveryRequiredError)
    expect(fs.existsSync(options.databaseFile)).toBe(false)
    expect(fs.readFileSync(options.dataFile, 'utf8')).toBe(source)
  }
)

it('fails closed when authority evidence cannot be inspected', () => {
  const options = fixture('json')
  const lstat = fs.lstatSync
  vi.spyOn(fs, 'lstatSync').mockImplementation((path, ...args) => {
    if (path === profileStateAuthorityMarkerPath(options.databaseFile)) {
      throw Object.assign(new Error('denied'), { code: 'EACCES' })
    }
    return lstat(path, ...args)
  })
  expect(() => bootstrapProfileStateAuthority(options)).toThrow(ProfileStateRecoveryRequiredError)
  expect(fs.existsSync(options.databaseFile)).toBe(false)
})
