import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
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
import { openProfileStateDatabase } from '../persistence/profile-state/profile-state-database'
import {
  createDefaultLocalOrcaProfile,
  DEFAULT_LOCAL_ORCA_PROFILE_ID,
  DEFAULT_LOCAL_ORCA_PROFILE_NAME,
  ORCA_PROFILE_INDEX_SCHEMA_VERSION,
  type OrcaProfileIndex
} from '../../shared/orca-profiles'

const testState = { dir: '' }

// Why the port and not vi.mock('electron'): profile path resolution reads AppEnvironment
// now, so an electron mock would be inert and every case would share the global fake's
// one temp dir instead of its own.
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
    // Why re-install per test: the global setup's beforeEach reinstates its own fake.
    installFakeAppEnvironment({ getPath: () => testState.dir })
  })

  afterEach(() => {
    removeTreeSync(testState.dir)
  })

  it('creates the default local profile and copies legacy state without deleting it', async () => {
    const legacyState = { schemaVersion: 1, repos: [{ id: 'repo-1' }] }
    const legacyBackup = { schemaVersion: 1, repos: [{ id: 'backup-repo' }] }
    const legacyBrowserSessionMeta = {
      defaultSource: { browserFamily: 'chrome', importedAt: 1 },
      profiles: []
    }
    writeFileSync(join(testState.dir, 'orca-data.json'), JSON.stringify(legacyState), 'utf-8')
    writeFileSync(
      join(testState.dir, 'orca-data.json.bak.0'),
      JSON.stringify(legacyBackup),
      'utf-8'
    )
    writeFileSync(
      join(testState.dir, 'browser-session-meta.json'),
      JSON.stringify(legacyBrowserSessionMeta),
      'utf-8'
    )

    const { ensureActiveOrcaProfile, getOrcaProfileIndexPath } = await loadProfileIndexStore()
    const activeProfile = ensureActiveOrcaProfile()

    expect(activeProfile.profile.id).toBe(DEFAULT_LOCAL_ORCA_PROFILE_ID)
    expect(activeProfile.profile.name).toBe(DEFAULT_LOCAL_ORCA_PROFILE_NAME)
    expect(activeProfile.dataFile).toBe(
      join(testState.dir, 'profiles', DEFAULT_LOCAL_ORCA_PROFILE_ID, 'orca-data.json')
    )
    expect(activeProfile.stateDatabaseFile).toBe(
      join(testState.dir, 'profiles', DEFAULT_LOCAL_ORCA_PROFILE_ID, 'profile-state.db')
    )
    expect(readJson(activeProfile.dataFile)).toEqual(legacyState)
    expect(readJson(`${activeProfile.dataFile}.bak.0`)).toEqual(legacyBackup)
    expect(
      readJson(
        join(testState.dir, 'profiles', DEFAULT_LOCAL_ORCA_PROFILE_ID, 'browser-session-meta.json')
      )
    ).toEqual(legacyBrowserSessionMeta)
    expect(existsSync(join(testState.dir, 'orca-data.json'))).toBe(true)

    expect(readJson(getOrcaProfileIndexPath())).toMatchObject({
      schemaVersion: ORCA_PROFILE_INDEX_SCHEMA_VERSION,
      activeProfileId: DEFAULT_LOCAL_ORCA_PROFILE_ID,
      profiles: [expect.objectContaining({ id: DEFAULT_LOCAL_ORCA_PROFILE_ID, kind: 'local' })]
    })
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
    'profile-state.db-journal'
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

  it('creates an empty local profile without copying legacy state into it', async () => {
    writeFileSync(
      join(testState.dir, 'orca-data.json'),
      JSON.stringify({ schemaVersion: 1, repos: [{ id: 'legacy-repo' }] }),
      'utf-8'
    )

    const { createLocalOrcaProfile, getOrcaProfileDataFile, getOrcaProfileListState } =
      await loadProfileIndexStore()
    const created = createLocalOrcaProfile({ name: ' Work ' })

    expect(created.profile.name).toBe('Work')
    expect(created.profile.id).toMatch(/^local-/)
    expect(created.activeProfileId).toBe(DEFAULT_LOCAL_ORCA_PROFILE_ID)
    expect(created.profiles.map((profile) => profile.id)).toContain(created.profile.id)
    expect(existsSync(getOrcaProfileDataFile(created.profile.id))).toBe(false)
    expect(getOrcaProfileListState().profiles.map((profile) => profile.id)).toContain(
      created.profile.id
    )
  })

  it('switches the active profile and updates last-opened metadata', async () => {
    const { createLocalOrcaProfile, setActiveOrcaProfile } = await loadProfileIndexStore()
    const created = createLocalOrcaProfile({ name: 'Work' })

    const switched = setActiveOrcaProfile(created.profile.id)

    expect(switched.activeProfileId).toBe(created.profile.id)
    expect(switched.profiles.find((profile) => profile.id === created.profile.id)).toMatchObject({
      id: created.profile.id,
      lastOpenedAt: expect.any(Number)
    })
  })

  it('rejects switching to an unknown profile', async () => {
    const { setActiveOrcaProfile } = await loadProfileIndexStore()

    expect(() => setActiveOrcaProfile('missing-profile')).toThrow('unknown_orca_profile')
  })

  const posixIt = process.platform === 'win32' ? it.skip : it
  posixIt('writes a fresh profile index when umask removes owner-write permission', async () => {
    const store = await loadProfileIndexStore()
    const indexPath = store.getOrcaProfileIndexPath()
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

  it('recovers a corrupted profile index from the backup copy', async () => {
    const store = await loadProfileIndexStore()
    store.ensureActiveOrcaProfile()
    const created = store.createLocalOrcaProfile({ name: 'Work' })
    // Trigger one more write so the backup captures the two-profile index.
    store.setActiveOrcaProfile(created.profile.id)

    const indexPath = store.getOrcaProfileIndexPath()
    expect(existsSync(`${indexPath}.bak`)).toBe(true)
    writeFileSync(indexPath, '{ not json', 'utf-8')

    const recovered = store.getOrcaProfileListState()
    expect(recovered.profiles.map((profile) => profile.id)).toContain(created.profile.id)
    expect(recovered.profiles.length).toBeGreaterThanOrEqual(2)
  })

  it('retains the selected profile when only its backup index remains', async () => {
    const store = await loadProfileIndexStore()
    store.ensureActiveOrcaProfile()
    const created = store.createLocalOrcaProfile({ name: 'Work' })
    store.setActiveOrcaProfile(created.profile.id)
    const indexPath = store.getOrcaProfileIndexPath()
    renameSync(indexPath, `${indexPath}.bak`)

    expect(store.loadOrCreateProfileIndex(testState.dir).activeProfileId).toBe(created.profile.id)
    expect(store.ensureActiveOrcaProfile().profile.id).toBe(created.profile.id)
    expect(readJson(indexPath)).toMatchObject({ activeProfileId: created.profile.id })
  })

  it.each(['primary', 'backup', 'both'] as const)(
    'refuses an unreadable %s index without replacing it',
    async (source) => {
      const store = await loadProfileIndexStore()
      const indexPath = store.getOrcaProfileIndexPath()
      if (source !== 'backup') {
        writeFileSync(indexPath, '{broken-primary')
      }
      if (source !== 'primary') {
        writeFileSync(`${indexPath}.bak`, '{broken-backup')
      }

      expect(() => store.loadOrCreateProfileIndex(testState.dir)).toThrow(
        'Could not read active profile index'
      )
      expect(() => store.ensureActiveOrcaProfile()).toThrow('Could not read active profile index')
      if (source !== 'backup') {
        expect(readFileSync(indexPath, 'utf8')).toBe('{broken-primary')
      }
      if (source !== 'primary') {
        expect(readFileSync(`${indexPath}.bak`, 'utf8')).toBe('{broken-backup')
      }
      expect(existsSync(join(testState.dir, 'profiles'))).toBe(false)
    }
  )

  it('rejects profile ids that are not safe path segments', async () => {
    const store = await loadProfileIndexStore()
    const indexPath = store.getOrcaProfileIndexPath()
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
