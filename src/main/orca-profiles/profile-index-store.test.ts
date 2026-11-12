import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeAppEnvironment } from '../../../config/scripts/test-runtime/environment/vitest-host-ports-setup'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync
} from 'node:fs'
import { removeTreeSync } from '../../shared/windows-transient-lock-removal'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openProfileStateDatabase } from '../persistence/profile-state/database/profile-state-database'
import {
  createDefaultLocalOrcaProfile,
  DEFAULT_LOCAL_ORCA_PROFILE_ID,
  ORCA_PROFILE_INDEX_SCHEMA_VERSION,
  type OrcaProfileIndex
} from '../../shared/orca-profiles'

const testState = { dir: '' }

// Profile resolution uses AppEnvironment; an Electron mock would leave the global fake directory.
installFakeAppEnvironment({ getPath: () => testState.dir })

async function loadProfileIndexStore() {
  vi.resetModules()
  return import('./profile-index-store')
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf-8'))
}

describe('profile index store', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-profile-test-'))
    // Global test setup reinstalls its own fake before each test.
    installFakeAppEnvironment({ getPath: () => testState.dir })
  })

  afterEach(() => {
    removeTreeSync(testState.dir)
  })

  it('uses an existing active profile data file without overwriting it from legacy state', async () => {
    const profileId = 'work-profile'
    const profileDirectory = join(testState.dir, 'profiles', profileId)
    const profileData = { schemaVersion: 1, repos: [{ id: 'profile-repo' }] }
    mkdirSync(profileDirectory, { recursive: true })
    writeFileSync(join(profileDirectory, 'orca-data.json'), JSON.stringify(profileData), 'utf-8')
    writeFileSync(
      join(testState.dir, 'orca-data.json'),
      JSON.stringify({ schemaVersion: 1, repos: [{ id: 'legacy-repo' }] }),
      'utf-8'
    )
    const index: OrcaProfileIndex = {
      schemaVersion: ORCA_PROFILE_INDEX_SCHEMA_VERSION,
      activeProfileId: profileId,
      profiles: [
        {
          id: profileId,
          name: 'Work',
          avatar: { kind: 'initials', initials: 'W', color: 'neutral' },
          kind: 'local',
          createdAt: 1,
          updatedAt: 1,
          lastOpenedAt: 1
        }
      ]
    }
    writeFileSync(join(testState.dir, 'orca-profile-index.json'), JSON.stringify(index), 'utf-8')

    const { ensureActiveOrcaProfile } = await loadProfileIndexStore()
    const activeProfile = ensureActiveOrcaProfile()

    expect(activeProfile.profile.id).toBe(profileId)
    expect(activeProfile.dataFile).toBe(join(profileDirectory, 'orca-data.json'))
    expect(activeProfile.stateDatabaseFile).toBe(join(profileDirectory, 'profile-state.db'))
    expect(readJson(activeProfile.dataFile)).toEqual(profileData)
  })

  it('does not copy legacy JSON into a database-only default profile', async () => {
    writeFileSync(
      join(testState.dir, 'orca-data.json'),
      JSON.stringify({ settings: { theme: 'legacy' } }),
      'utf-8'
    )
    const profileDirectory = join(testState.dir, 'profiles', DEFAULT_LOCAL_ORCA_PROFILE_ID)
    mkdirSync(profileDirectory, { recursive: true })
    const database = openProfileStateDatabase(
      join(profileDirectory, 'profile-state.db'),
      DEFAULT_LOCAL_ORCA_PROFILE_ID
    )
    database.db.close()

    const { ensureActiveOrcaProfile } = await loadProfileIndexStore()
    const activeProfile = ensureActiveOrcaProfile()

    expect(activeProfile.stateDatabaseFile).toBe(join(profileDirectory, 'profile-state.db'))
    expect(existsSync(activeProfile.dataFile)).toBe(false)
    expect(readFileSync(join(testState.dir, 'orca-data.json'), 'utf-8')).toContain('legacy')
  })

  it.each([
    'orca-data.json.sqlite-export.1.json',
    'profile-state.db.backup.1789999999999-00000000-0000-4000-8000-000000000000.db',
    'profile-state.db-wal',
    'profile-state.db-shm',
    'profile-state.db-journal',
    'profile-state.db.authority'
  ])('does not seed a stale mirror when %s exists without the database', async (artifact) => {
    writeFileSync(
      join(testState.dir, 'orca-data.json'),
      JSON.stringify({ settings: { theme: 'legacy' } }),
      'utf-8'
    )
    const profileDirectory = join(testState.dir, 'profiles', DEFAULT_LOCAL_ORCA_PROFILE_ID)
    mkdirSync(profileDirectory, { recursive: true })
    writeFileSync(
      join(profileDirectory, artifact),
      JSON.stringify({ settings: { theme: 'migrated' } }),
      'utf-8'
    )

    const { ensureActiveOrcaProfile } = await loadProfileIndexStore()
    const activeProfile = ensureActiveOrcaProfile()

    expect(existsSync(activeProfile.dataFile)).toBe(false)
    expect(readFileSync(join(testState.dir, 'orca-data.json'), 'utf-8')).toContain('legacy')
  })

  const posixIt = process.platform === 'win32' ? it.skip : it
  posixIt('writes a fresh profile index when umask removes owner-write permission', async () => {
    const store = await loadProfileIndexStore()
    const indexPath = (await import('./profile-storage-paths')).getOrcaProfileIndexPath()
    const profile = createDefaultLocalOrcaProfile(1)
    const index: OrcaProfileIndex = {
      schemaVersion: ORCA_PROFILE_INDEX_SCHEMA_VERSION,
      activeProfileId: profile.id,
      profiles: [profile]
    }
    const originalUmask = process.umask(0o200)

    try {
      expect(() => store.writeProfileIndex(indexPath, index)).not.toThrow()
    } finally {
      process.umask(originalUmask)
    }

    expect(readJson(indexPath)).toEqual(index)
  })

  it('retains the selected profile when only its backup index remains', async () => {
    const store = await loadProfileIndexStore()
    store.ensureActiveOrcaProfile()
    const created = store.createLocalOrcaProfile({ name: 'Work' })
    store.setActiveOrcaProfile(created.profile.id)
    const indexPath = (await import('./profile-storage-paths')).getOrcaProfileIndexPath()
    renameSync(indexPath, `${indexPath}.bak`)

    expect(store.loadOrCreateProfileIndex(testState.dir).activeProfileId).toBe(created.profile.id)
    expect(store.ensureActiveOrcaProfile().profile.id).toBe(created.profile.id)
    expect(readJson(indexPath)).toMatchObject({ activeProfileId: created.profile.id })
  })

  it('rejects profile ids that are not safe path segments', async () => {
    const store = await loadProfileIndexStore()
    const indexPath = (await import('./profile-storage-paths')).getOrcaProfileIndexPath()
    const index: OrcaProfileIndex = {
      schemaVersion: ORCA_PROFILE_INDEX_SCHEMA_VERSION,
      activeProfileId: '../../escape',
      profiles: [
        {
          id: '../../escape',
          name: 'Evil',
          avatar: { kind: 'initials', initials: 'E', color: 'neutral' },
          kind: 'local',
          createdAt: 1,
          updatedAt: 1,
          lastOpenedAt: 1
        }
      ]
    }
    mkdirSync(testState.dir, { recursive: true })
    writeFileSync(indexPath, JSON.stringify(index), 'utf-8')

    expect(() => store.ensureActiveOrcaProfile()).toThrow('Could not read active profile index')
    expect(readJson(indexPath)).toEqual(index)
  })
})
