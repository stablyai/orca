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
import { getDefaultPersistedState } from '../../../shared/constants'
import { ORCA_PROFILE_INDEX_SCHEMA_VERSION } from '../../../shared/orca-profiles'
import type { Repo } from '../../../shared/repo-types'
import * as profileStateDocuments from '../../persistence/profile-state/documents/profile-state-documents'
import { openProfileStateDatabase } from '../../persistence/profile-state/database/profile-state-database'
import { ProfileStateSqliteAuthority } from '../../persistence/profile-state/profile-state-sqlite-authority'
import {
  createProfileStateDatabaseBackupId,
  profileStateDatabaseBackupPath
} from '../../persistence/profile-state/backup/profile-state-backup-path'
import { transferOrcaProfileProject } from './profile-project-transfer'
import {
  readProfileStateWithRevision,
  writeSerializedProfileState
} from './profile-project-state-file'

vi.mock('../../persistence/loading-store/store', () => {
  throw new Error('Profile transfers must not load inactive Stores')
})

const repo: Repo = {
  id: 'repo-1',
  path: '/projects/folder',
  displayName: 'Folder',
  badgeColor: 'neutral',
  addedAt: 1,
  kind: 'folder',
  connectionId: null
}
let directory: string

function paths(profileId: string): { dataFile: string; databaseFile: string } {
  return {
    dataFile: join(directory, 'profiles', profileId, 'orca-data.json'),
    databaseFile: join(directory, 'profiles', profileId, 'profile-state.db')
  }
}

function writeState(profileId: string, sqlite: boolean, repos: Repo[] = []): string {
  const defaults = getDefaultPersistedState('/home/test')
  const source = JSON.stringify(
    {
      ...defaults,
      repos,
      futureDomain: { profileId },
      settings: { ...defaults.settings, opencodeSessionCookie: 'enc:v1:sealed-inactive-secret' }
    },
    null,
    2
  )
  const location = paths(profileId)
  mkdirSync(join(location.dataFile, '..'), { recursive: true })
  if (sqlite) {
    const opened = openProfileStateDatabase(location.databaseFile, profileId)
    try {
      profileStateDocuments.importProfileStateJson(opened.db, source)
    } finally {
      opened.db.close()
    }
  } else {
    writeFileSync(location.dataFile, source)
  }
  return source
}

function transfer(mode: 'copy' | 'move' = 'move') {
  return transferOrcaProfileProject(
    {
      sourceProfileId: 'source',
      targetProfileId: 'target',
      repoId: repo.id,
      mode
    },
    directory
  )
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-profile-transfer-migration-'))
  writeFileSync(
    join(directory, 'orca-profile-index.json'),
    JSON.stringify({
      schemaVersion: ORCA_PROFILE_INDEX_SCHEMA_VERSION,
      activeProfileId: 'source',
      profiles: ['source', 'target'].map((id) => ({
        id,
        name: id,
        avatar: { kind: 'initials', initials: id[0], color: 'neutral' },
        kind: 'local',
        createdAt: 1,
        updatedAt: 1,
        lastOpenedAt: 1
      }))
    })
  )
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(directory, { recursive: true, force: true })
})

describe('profile transfer migration', () => {
  it('migrates a JSON source before moving into SQLite and retains its exact rollback bytes', () => {
    const sourceJson = writeState('source', false, [repo])
    writeState('target', true)
    expect(transfer()).toMatchObject({ status: 'transferred' })
    expect(readProfileStateWithRevision('source', directory)).toMatchObject({
      revision: 2,
      state: { repos: [] }
    })
    expect(readProfileStateWithRevision('target', directory).state.repos).toHaveLength(1)
    expect(readFileSync(paths('source').dataFile, 'utf8')).toBe(sourceJson)
  })

  it('copies from JSON into SQLite without migrating or changing the source', () => {
    const sourceJson = writeState('source', false, [repo])
    writeState('target', true)
    expect(transfer('copy')).toMatchObject({ status: 'transferred' })
    expect(readFileSync(paths('source').dataFile, 'utf8')).toBe(sourceJson)
    expect(existsSync(paths('source').databaseFile)).toBe(false)
    expect(readProfileStateWithRevision('target', directory).state.repos).toHaveLength(1)
  })

  it('refuses a legacy JSON write outside participant migration', () => {
    const sourceJson = writeState('source', false, [repo])
    expect(() => writeSerializedProfileState('source', directory, '{}')).toThrow(
      'established SQLite participant'
    )
    expect(readFileSync(paths('source').dataFile, 'utf8')).toBe(sourceJson)
    expect(() => writeSerializedProfileState('target', directory, '{}')).toThrow(
      'established SQLite participant'
    )
    expect(existsSync(paths('target').dataFile)).toBe(false)
    expect(existsSync(paths('target').databaseFile)).toBe(false)
  })

  it('refuses to adopt stale target JSON when a retained database backup proves missing authority', () => {
    writeState('source', true, [repo])
    writeState('target', false)
    const backupPath = profileStateDatabaseBackupPath(
      paths('target').databaseFile,
      createProfileStateDatabaseBackupId(1)
    )
    writeFileSync(backupPath, 'retained recovery evidence')
    expect(() => transfer()).toThrowError(
      expect.objectContaining({
        code: 'profile-state-recovery-required',
        backupPaths: [backupPath]
      })
    )
    expect(existsSync(paths('target').databaseFile)).toBe(false)
    expect(readProfileStateWithRevision('source', directory).state.repos).toHaveLength(1)
  })

  it('leaves both participants untouched when the import fails before publication', () => {
    writeState('source', true, [repo])
    const targetJson = writeState('target', false)
    vi.spyOn(profileStateDocuments, 'importProfileStateJson').mockImplementation(() => {
      throw new Error('import failure')
    })
    expect(() => transfer()).toThrow('import failure')
    expect(readProfileStateWithRevision('source', directory).state.repos).toHaveLength(1)
    expect(readFileSync(paths('target').dataFile, 'utf8')).toBe(targetJson)
    expect(existsSync(paths('target').databaseFile)).toBe(false)
    expect(readdirSync(join(paths('target').dataFile, '..'))).toEqual(['orca-data.json'])
  })

  it('rejects a JSON edit during migration before publishing SQLite', () => {
    writeState('source', true, [repo])
    writeState('target', false)
    const originalImport = profileStateDocuments.importProfileStateJson
    vi.spyOn(profileStateDocuments, 'importProfileStateJson').mockImplementation((...args) => {
      const revision = originalImport(...args)
      writeFileSync(paths('target').dataFile, '{"settings":{"theme":"light"}}')
      return revision
    })
    expect(() => transfer()).toThrow('JSON changed while importing')
    expect(existsSync(paths('target').databaseFile)).toBe(false)
    expect(readProfileStateWithRevision('source', directory).state.repos).toHaveLength(1)
  })

  it('keeps a valid migrated participant after export failure without moving the project', () => {
    writeState('source', true, [repo])
    const targetJson = writeState('target', false)
    vi.spyOn(ProfileStateSqliteAuthority.prototype, 'writeJsonExport').mockImplementation(() => {
      throw new Error('export failure')
    })
    expect(() => transfer()).toThrow('export failure')
    expect(readProfileStateWithRevision('source', directory).state.repos).toHaveLength(1)
    expect(readProfileStateWithRevision('target', directory).state.repos).toHaveLength(0)
    expect(readFileSync(paths('target').dataFile, 'utf8')).toBe(targetJson)
  })
})
