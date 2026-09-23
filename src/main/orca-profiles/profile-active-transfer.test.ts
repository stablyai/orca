import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultPersistedState } from '../../shared/constants'
import { ORCA_PROFILE_INDEX_SCHEMA_VERSION } from '../../shared/orca-profiles'
import { openProfileStateDatabase } from '../persistence/profile-state/profile-state-database'
import { importProfileStateJson } from '../persistence/profile-state/profile-state-documents'
import { ProfileStateSqliteAuthority } from '../persistence/profile-state/profile-state-sqlite-authority'
import * as stateFiles from './profile-project-state-file'
import * as moveIntents from './profile-project-move-intent'
import { transferActiveProfileProject } from './profile-active-transfer'
import { transferOrcaProfileProject } from './profile-project-transfer'

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
vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn(() => ({ nth_repo_added: 2 }))
}))
vi.mock('../ssh/ssh-config-parser', () => ({
  loadUserSshConfig: vi.fn(() => ({ hosts: [] })),
  sshConfigHostsToTargets: vi.fn(() => [])
}))

const { Store } = await import('../persistence/loading-store/store')
const stores: InstanceType<typeof Store>[] = []
let directory: string
const args = {
  sourceProfileId: 'source',
  targetProfileId: 'target',
  repoId: 'repo-1',
  mode: 'move'
} as const

function snapshot(profileId: string) {
  return stateFiles.readProfileStateWithRevision(profileId, directory)
}

function openStore() {
  const profileDirectory = join(directory, 'profiles', 'source')
  const store = new Store({
    dataFile: join(profileDirectory, 'orca-data.json'),
    profileStateAuthority: new ProfileStateSqliteAuthority(
      join(profileDirectory, 'profile-state.db'),
      'source'
    )
  })
  stores.push(store)
  store.flushOrThrow()
  return store
}

function interruptSourceCommit() {
  const originalWrite = stateFiles.writeProfileState
  return vi.spyOn(stateFiles, 'writeProfileState').mockImplementation((profileId, ...rest) => {
    if (profileId === 'source') {
      throw new Error('source commit interrupted')
    }
    return originalWrite(profileId, ...rest)
  })
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-active-profile-transfer-'))
  vi.spyOn(ProfileStateSqliteAuthority.prototype, 'scheduleBackup').mockImplementation(() => {})
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
  for (const profileId of ['source', 'target']) {
    const profileDirectory = join(directory, 'profiles', profileId)
    mkdirSync(profileDirectory, { recursive: true })
    const db = openProfileStateDatabase(join(profileDirectory, 'profile-state.db'), profileId).db
    try {
      importProfileStateJson(
        db,
        JSON.stringify({
          ...getDefaultPersistedState('/home/test'),
          repos:
            profileId === 'source'
              ? [{ id: 'repo-1', path: '/projects/folder', kind: 'folder', addedAt: 1 }]
              : []
        })
      )
    } finally {
      db.close()
    }
  }
})

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.freezeWrites()
  }
  vi.restoreAllMocks()
  rmSync(directory, { recursive: true, force: true })
})

describe('active profile transfer recovery', () => {
  it.each(['source commit', 'intent cleanup'] as const)(
    'fences an existing SQLite Store after interrupted %s until recovery and reopen',
    async (failure) => {
      const store = openStore()
      const before = snapshot('source')
      const interrupted =
        failure === 'source commit'
          ? interruptSourceCommit()
          : vi.spyOn(moveIntents, 'removeProfileProjectMoveIntent').mockImplementation(() => {
              throw new Error('intent cleanup interrupted')
            })
      const reopen = vi.fn(async () => {
        const retained = snapshot('source')
        store.updateSettings({ theme: 'light' })
        store.flushOrThrow()
        expect(snapshot('source')).toEqual(retained)
      })

      await expect(transferActiveProfileProject(args, directory, store, reopen)).rejects.toThrow(
        `${failure} interrupted`
      )
      expect(reopen).toHaveBeenCalledOnce()
      expect(snapshot('source').revision).toBe(
        (before.revision ?? 0) + (failure === 'source commit' ? 0 : 1)
      )
      expect(snapshot('target').state.repos).toHaveLength(1)
      interrupted.mockRestore()

      expect(moveIntents.recoverPendingProfileProjectMoves(directory)).toBe(1)
      expect(moveIntents.recoverPendingProfileProjectMoves(directory)).toBe(0)
      expect(snapshot('source').state.repos).toHaveLength(0)
      expect(snapshot('target').state.repos).toHaveLength(1)
      const reloaded = openStore()
      reloaded.updateSettings({ theme: 'light' })
      reloaded.flushOrThrow()
      expect(snapshot('source').state.settings.theme).toBe('light')
      expect(moveIntents.recoverPendingProfileProjectMoves(directory)).toBe(0)
    }
  )

  it('leaves an unchanged SQLite Store writable after validation fails', async () => {
    const store = openStore()
    const before = snapshot('source')
    const reopen = vi.fn(async () => {})
    await expect(
      transferActiveProfileProject({ ...args, repoId: 'missing' }, directory, store, reopen)
    ).rejects.toThrow('unknown_source_repo')
    expect(reopen).not.toHaveBeenCalled()
    store.updateSettings({ theme: 'light' })
    store.flushOrThrow()
    expect(snapshot('source').revision).toBe((before.revision ?? 0) + 1)
    expect(snapshot('source').state.settings.theme).toBe('light')
  })

  it('keeps writes fenced when reopening after a partial transfer fails', async () => {
    const store = openStore()
    const before = snapshot('source')
    const interrupted = interruptSourceCommit()
    await expect(
      transferActiveProfileProject(args, directory, store, async () => {
        throw new Error('reopen failed')
      })
    ).rejects.toThrow('reopen failed')
    store.updateSettings({ theme: 'light' })
    store.flushOrThrow()
    expect(snapshot('source')).toEqual(before)
    interrupted.mockRestore()
    expect(moveIntents.recoverPendingProfileProjectMoves(directory)).toBe(1)
  })

  it('reopens before an outstanding move can change the active Store behind its revision', async () => {
    const store = openStore()
    const interrupted = interruptSourceCommit()
    expect(() => transferOrcaProfileProject(args, directory)).toThrow('source commit interrupted')
    interrupted.mockRestore()
    const reopen = vi.fn(async () => {
      expect(moveIntents.recoverPendingProfileProjectMoves(directory)).toBe(1)
    })
    await expect(transferActiveProfileProject(args, directory, store, reopen)).rejects.toThrow(
      'active_source_orca_profile_move_requires_recovery'
    )
    const recovered = snapshot('source')
    store.updateSettings({ theme: 'light' })
    store.flushOrThrow()
    expect(snapshot('source')).toEqual(recovered)
    expect(reopen).toHaveBeenCalledOnce()
  })

  it('keeps the Store frozen when an unreadable intent cannot identify its participants', async () => {
    const store = openStore()
    const before = snapshot('source')
    const intentDirectory = join(directory, 'profile-move-intents')
    mkdirSync(intentDirectory)
    writeFileSync(join(intentDirectory, '11111111-1111-4111-8111-111111111111.json'), '{')
    const reopen = vi.fn(async () => {
      moveIntents.recoverPendingProfileProjectMoves(directory)
    })
    await expect(transferActiveProfileProject(args, directory, store, reopen)).rejects.toThrow(
      'Profile move intent is unreadable'
    )
    store.updateSettings({ theme: 'light' })
    store.flushOrThrow()
    expect(snapshot('source')).toEqual(before)
    expect(reopen).toHaveBeenCalledOnce()
  })
})
