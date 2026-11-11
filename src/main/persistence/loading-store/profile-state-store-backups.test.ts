import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushActiveProfileBeforeFileMutation } from '../../orca-profiles/profile-persistence-deadline'
import { openProfileStateDatabaseReadOnly } from '../profile-state/profile-state-database'
import { readProfileStateSnapshot } from '../profile-state/profile-state-documents'
import { profileStateDatabaseBackups } from '../profile-state/profile-state-backup-path'
import * as backupExecution from '../profile-state/profile-state-backup-worker'
import { ProfileStateSqliteAuthority } from '../profile-state/profile-state-sqlite-authority'
import { Store } from './store'

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
vi.mock('../../ssh/config/ssh-config-parser', () => ({
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
      expect(readFileSync(state.retained[0].path).equals(state.retainedBytes)).toBe(true)
      expect(readFileSync(state.dataFile, 'utf8')).toBe(state.legacyBytes)
    }
  )
})
