import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushActiveProfileBeforeFileMutation } from '../../orca-profiles/profile-persistence-deadline'
import { openProfileStateDatabaseReadOnly } from '../profile-state/profile-state-database'
import { readProfileStateSnapshot } from '../profile-state/profile-state-documents'
import { profileStateDatabaseBackups } from '../profile-state/profile-state-backup-path'
import * as backupExecution from '../profile-state/profile-state-backup-worker'
import { ProfileStateSqliteAuthority } from '../profile-state/profile-state-sqlite-authority'
import { Store } from './store'
import { scheduleSave } from './write-scheduling'

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpdir(),
    getName: () => 'orca-test',
    getVersion: () => '0.0.0-test',
    isPackaged: false,
    on: () => {},
    whenReady: () => Promise.resolve()
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`),
    decryptString: (value: Buffer) => value.toString().slice('encrypted:'.length)
  },
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

const PROFILE_ID = 'store-backup-test'
const HOUR = 60 * 60 * 1000
const fixtures: { directory: string; store: Store; authority: ProfileStateSqliteAuthority }[] = []
const releases: (() => void)[] = []

beforeEach(() => {
  vi.spyOn(backupExecution, 'runProfileStateBackup')
})

afterEach(async () => {
  for (const release of releases.splice(0)) {
    release()
  }
  for (const fixture of fixtures.splice(0)) {
    await fixture.authority.drainBackups()
    fixture.store.freezeWrites()
    await fixture.store.flushAsync()
    rmSync(fixture.directory, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'orca-store-backup-'))
  const databasePath = join(directory, 'profile-state.db')
  const dataFile = join(directory, 'orca-data.json')
  const legacyBytes = '{"settings":{"theme":"system"},"legacy":"retained"}'
  writeFileSync(dataFile, legacyBytes)
  const beginning = Date.now()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(beginning)
  const authority = new ProfileStateSqliteAuthority(databasePath, PROFILE_ID)
  const store = new Store({ dataFile, profileStateAuthority: authority })
  fixtures.push({ directory, store, authority })
  store.updateSettings({ theme: 'light' })
  store.flushOrThrow()
  await authority.drainBackups()
  const retained = profileStateDatabaseBackups(databasePath)
  expect(retained).toHaveLength(1)
  const retainedBytes = readFileSync(retained[0].path)
  clock.mockReturnValue(beginning + HOUR + 1)
  return {
    directory,
    databasePath,
    dataFile,
    legacyBytes,
    store,
    authority,
    retained,
    retainedBytes
  }
}

function readSnapshot(path: string) {
  const opened = openProfileStateDatabaseReadOnly(path, PROFILE_ID)
  try {
    const snapshot = readProfileStateSnapshot(opened.db)
    return { revision: snapshot.revision, state: JSON.parse(snapshot.json) }
  } finally {
    opened.db.close()
  }
}

describe('Store automatic SQLite recovery snapshots', () => {
  it.each([
    ['selective', 'sync'],
    ['selective', 'async'],
    ['complete', 'sync'],
    ['complete', 'async']
  ] as const)('backs up a %s %s commit without rewriting retained JSON', async (scope, flush) => {
    const state = await fixture()
    const fullWrite = vi.spyOn(state.authority, 'writeCompleteSerializedDomains')
    const selectiveWrite = vi.spyOn(state.authority, 'writeSerializedDomains')
    state.store.patchWorkspaceSession({ activeWorktreeId: 'backup-worktree' })
    if (scope === 'complete') {
      scheduleSave(state.store)
    }
    if (flush === 'sync') {
      state.store.flushOrThrow()
      await state.authority.drainBackups()
    } else {
      await state.store.flushPendingOrThrowAsync()
    }

    await state.authority.drainBackups()
    expect(scope === 'complete' ? fullWrite : selectiveWrite).toHaveBeenCalledOnce()
    expect(scope === 'complete' ? selectiveWrite : fullWrite).not.toHaveBeenCalled()
    const backups = profileStateDatabaseBackups(state.databasePath)
    expect(backups).toHaveLength(2)
    expect(readSnapshot(backups[0].path)).toEqual(readSnapshot(state.databasePath))
    expect(readSnapshot(backups[0].path).state.workspaceSession.activeWorktreeId).toBe(
      'backup-worktree'
    )
    expect(readFileSync(state.retained[0].path)).toEqual(state.retainedBytes)
    expect(readFileSync(state.dataFile, 'utf8')).toBe(state.legacyBytes)
    expect(
      readdirSync(state.directory)
        .filter((name) => name.includes('.backup.'))
        .sort()
    ).toEqual(backups.map((backup) => basename(backup.path)).sort())
  })

  it('acknowledges a routine flush while the previous recovery backup is still running', async () => {
    const state = await fixture()
    const realSnapshot = backupExecution.runProfileStateBackup
    const started = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    releases.push(gate.resolve)
    vi.spyOn(backupExecution, 'runProfileStateBackup').mockImplementationOnce(async (job) => {
      started.resolve()
      await gate.promise
      await realSnapshot(job)
    })
    state.store.updateSettings({ theme: 'dark' })
    state.store.flushOrThrow()
    await started.promise
    state.store.patchWorkspaceSession({ activeWorktreeId: 'newer-than-backup' })
    let settled = false
    const flush = state.store.flushPendingOrThrowAsync().then(() => {
      settled = true
    })
    await vi.waitFor(() => expect(settled).toBe(true))
    expect(readSnapshot(state.databasePath).state.workspaceSession.activeWorktreeId).toBe(
      'newer-than-backup'
    )
    expect(profileStateDatabaseBackups(state.databasePath)).toHaveLength(1)
    gate.resolve()
    await Promise.all([flush, state.authority.drainBackups()])
  })

  it.each(['quit', 'profile mutation'] as const)(
    '%s waits for its owned backup across Store close',
    async (kind) => {
      const state = await fixture()
      const realSnapshot = backupExecution.runProfileStateBackup
      let begin: () => void = () => {}
      let release: () => void = () => {}
      const started = new Promise<void>((resolve) => {
        begin = resolve
      })
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      releases.push(release)
      vi.spyOn(backupExecution, 'runProfileStateBackup').mockImplementationOnce(async (job) => {
        begin()
        await gate
        await realSnapshot(job)
      })
      state.store.updateSettings({ theme: 'dark' })
      state.store.flushOrThrow()
      await started
      const drain = vi.spyOn(state.authority, 'drainBackups')
      let settled = false
      const barrier = (
        kind === 'quit'
          ? state.store.flushAsync()
          : flushActiveProfileBeforeFileMutation(state.store)
      ).then(() => {
        settled = true
      })
      await vi.waitFor(() => expect(drain).toHaveBeenCalled())
      expect(settled).toBe(false)
      state.store.freezeWrites()
      expect(profileStateDatabaseBackups(state.databasePath)).toHaveLength(1)
      release()
      await barrier

      expect(settled).toBe(true)
      const backups = profileStateDatabaseBackups(state.databasePath)
      expect(backups).toHaveLength(2)
      expect(readSnapshot(backups[0].path).state.settings.theme).toBe('dark')
      expect(readFileSync(state.retained[0].path)).toEqual(state.retainedBytes)
      expect(readFileSync(state.dataFile, 'utf8')).toBe(state.legacyBytes)
    }
  )

  it.each(['sync', 'async'] as const)(
    'does not reject a committed %s flush when its backup fails',
    async (flush) => {
      const state = await fixture()
      const log = vi.spyOn(console, 'error').mockImplementation(() => {})
      const failure = new Error('injected backup disk failure')
      const snapshot = vi
        .spyOn(backupExecution, 'runProfileStateBackup')
        .mockClear()
        .mockRejectedValueOnce(failure)
      state.store.updateSettings({ theme: 'dark' })
      if (flush === 'sync') {
        expect(() => state.store.flushOrThrow()).not.toThrow()
        await expect(state.authority.drainBackups()).resolves.toBeUndefined()
      } else {
        await expect(state.store.flushPendingOrThrowAsync()).resolves.toBeUndefined()
      }

      await state.authority.drainBackups()
      expect(snapshot).toHaveBeenCalledOnce()
      expect(log).toHaveBeenCalledWith(
        '[persistence] Failed to back up profile state database:',
        failure
      )
      expect(readSnapshot(state.databasePath).state.settings.theme).toBe('dark')
      expect(profileStateDatabaseBackups(state.databasePath)).toEqual(state.retained)
      expect(readFileSync(state.retained[0].path)).toEqual(state.retainedBytes)
      expect(readSnapshot(state.retained[0].path).state.settings.theme).toBe('light')
      expect(readFileSync(state.dataFile, 'utf8')).toBe(state.legacyBytes)
      expect(existsSync(`${state.dataFile}.bak.0`)).toBe(false)
    }
  )
})
