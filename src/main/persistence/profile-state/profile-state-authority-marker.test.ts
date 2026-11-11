import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import * as durableFileWrite from '../../filesystem/durable-file-write'
import {
  hasProfileStateAuthorityMarker,
  profileStateAuthorityMarkerPath
} from './profile-state-authority-marker'
import {
  openProfileStateDatabase,
  openProfileStateDatabaseReadOnly
} from './profile-state-database'
import { importProfileStateJson, readProfileStateSnapshot } from './profile-state-documents'
import { ProfileStateSqliteAuthority } from './profile-state-sqlite-authority'

vi.mock('node:fs', async (original) => ({ ...(await original<typeof fs>()) }))
vi.mock('../../telemetry/client', () => ({ track: () => {} }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../ssh/config/ssh-config-parser', () => ({
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
