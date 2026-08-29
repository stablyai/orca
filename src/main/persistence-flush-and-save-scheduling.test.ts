import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync, mkdirSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { PersistedState } from '../shared/persisted-state-types'
import type { Repo } from '../shared/repo-types'
import {
  testState,
  createStore,
  withPlatform,
  dataFile,
  writeDataFile,
  readDataFile,
  makeRepo
} from './persistence-test-harness'
import { TEST_LEAF_1 } from './persistence-session-fixtures'

// Stub the ~/.ssh/config parser so the SSH-import test drives the real Store with deterministic hosts, not the operator's actual ~/.ssh/config.
const { loadUserSshConfigMock, sshConfigHostsToTargetsMock } = vi.hoisted(() => ({
  loadUserSshConfigMock: vi.fn(),
  sshConfigHostsToTargetsMock: vi.fn()
}))

vi.mock('./ssh/ssh-config-parser', () => ({
  loadUserSshConfig: loadUserSshConfigMock,
  sshConfigHostsToTargets: sshConfigHostsToTargetsMock
}))
const { trackMock, getCohortAtEmitMock } = vi.hoisted(() => ({
  trackMock: vi.fn(),
  getCohortAtEmitMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.dir
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => {
      const decoded = ciphertext.toString('utf-8')
      if (!decoded.startsWith('encrypted:')) {
        throw new Error('invalid ciphertext')
      }
      return decoded.slice('encrypted:'.length)
    }
  }
}))

vi.mock('./telemetry/client', () => ({
  track: trackMock
}))

vi.mock('./telemetry/cohort-classifier', () => ({
  getCohortAtEmit: getCohortAtEmitMock
}))

describe('Store', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
    trackMock.mockReset()
    getCohortAtEmitMock.mockReset()
    getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })
  // ── 10. flush writes synchronously ─────────────────────────────────

  it('flush writes state to disk synchronously', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())
    store.flush()

    const persisted = readDataFile() as { repos: Repo[] }
    expect(persisted.repos).toHaveLength(1)
    expect(persisted.repos[0].id).toBe('r1')
  })

  it('flush remains safe when a debounced save is also pending', async () => {
    vi.useFakeTimers()
    try {
      const store = await createStore()
      store.addRepo(makeRepo())
      store.flush()
      vi.advanceTimersByTime(1000)

      const persisted = readDataFile() as { repos: Repo[] }
      expect(persisted.repos).toHaveLength(1)
      expect(persisted.repos[0].id).toBe('r1')
    } finally {
      vi.useRealTimers()
    }
  })

  // ── 11. Debounced save ─────────────────────────────────────────────

  it('debounced save writes data after the delay', async () => {
    vi.useFakeTimers()
    try {
      const store = await createStore()
      store.addRepo(makeRepo())

      // Before the debounce fires, file should not exist yet (or be stale)
      vi.advanceTimersByTime(100)
      // The 1s debounce hasn't elapsed yet

      vi.advanceTimersByTime(1000)
      // The timer fired; wait for the async disk write to complete
      await store.waitForPendingWrite()

      const persisted = readDataFile() as { repos: Repo[] }
      expect(persisted.repos).toHaveLength(1)
      expect(persisted.repos[0].id).toBe('r1')
    } finally {
      vi.useRealTimers()
    }
  })

  // ── Content-hash write skipping ────────────────────────────────────
  // Why inode comparison: every real write is a tmp+rename (new inode), so an unchanged inode proves no write happened.

  it('skips the disk write when a mutation burst nets out to already-persisted state', async () => {
    vi.useFakeTimers()
    try {
      const store = await createStore()
      store.updateUI({ sidebarWidth: 400 })
      vi.advanceTimersByTime(1000)
      await store.waitForPendingWrite()
      const inoBefore = statSync(dataFile()).ino

      store.updateUI({ sidebarWidth: 500 })
      store.updateUI({ sidebarWidth: 400 })
      vi.advanceTimersByTime(2000)
      await store.waitForPendingWrite()

      expect(statSync(dataFile()).ino).toBe(inoBefore)
    } finally {
      vi.useRealTimers()
    }
  })

  it('skips the sync flush when state already matches the last write', async () => {
    vi.useFakeTimers()
    try {
      const store = await createStore()
      store.updateUI({ sidebarWidth: 420 })
      vi.advanceTimersByTime(1000)
      await store.waitForPendingWrite()
      const inoBefore = statSync(dataFile()).ino

      store.flush()

      expect(statSync(dataFile()).ino).toBe(inoBefore)
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds save postponement under sustained mutation bursts (max-wait)', async () => {
    vi.useFakeTimers()
    try {
      const store = await createStore()
      // Mutations every 500ms reset the 1s debounce; the 5s max-wait must force a write anyway.
      let width = 400
      for (let i = 0; i < 11; i++) {
        store.updateUI({ sidebarWidth: width++ })
        vi.advanceTimersByTime(500)
      }
      await store.waitForPendingWrite()

      expect(existsSync(dataFile())).toBe(true)
      const persisted = readDataFile() as { ui: { sidebarWidth: number } }
      expect(persisted.ui.sidebarWidth).toBeGreaterThanOrEqual(400)
    } finally {
      vi.useRealTimers()
    }
  })

  it('re-binding an already-persisted pty does not rewrite the state file', async () => {
    const store = await createStore()
    store.setWorkspaceSession({
      activeRepoId: 'r1',
      activeWorktreeId: 'wt1',
      activeTabId: 'tab1',
      tabsByWorktree: {
        wt1: [
          {
            id: 'tab1',
            worktreeId: 'wt1',
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            ptyId: null
          }
        ]
      },
      terminalLayoutsByTabId: {
        tab1: {
          root: null,
          activeLeafId: null,
          expandedLeafId: null
        }
      }
    })

    const binding = {
      worktreeId: 'wt1',
      tabId: 'tab1',
      leafId: TEST_LEAF_1,
      ptyId: 'daemon-pty'
    }
    store.persistPtyBinding(binding)
    const inoBefore = statSync(dataFile()).ino

    // Warm-restart re-bind storm: an identical binding re-asserted with a sync flush must not rewrite.
    store.persistPtyBinding(binding)

    expect(statSync(dataFile()).ino).toBe(inoBefore)
  })

  // ── worktreeMeta startup GC ────────────────────────────────────────

  it('garbage-collects stale local worktreeMeta at load with a 30-day grace', async () => {
    const OLD = Date.now() - 40 * 24 * 60 * 60 * 1000
    const RECENT = Date.now() - 1 * 24 * 60 * 60 * 1000
    const missing = (name: string): string => join(testState.dir, 'gone', name)
    const meta = (lastActivityAt: number, extra: Record<string, unknown> = {}) => ({
      displayName: '',
      comment: '',
      lastActivityAt,
      ...extra
    })
    const liveKey = `r1::${testState.dir}`
    const deadKey = `r1::${missing('dead')}`
    const recentKey = `r1::${missing('recent')}`
    const sshKey = `ssh-repo::/home/alice/gone`
    const remoteHostKey = `r1::${missing('remote-host')}`
    const orphanKey = `removed-repo::${missing('orphan')}`
    const wslKey = `r1::\\\\wsl$\\Ubuntu\\home\\gone`

    writeDataFile({
      repos: [
        makeRepo(),
        makeRepo({ id: 'ssh-repo', path: '/home/alice/repo', connectionId: 'conn-1' })
      ],
      worktreeMeta: {
        [liveKey]: meta(OLD),
        [deadKey]: meta(OLD),
        [recentKey]: meta(RECENT),
        [sshKey]: meta(OLD),
        [remoteHostKey]: meta(OLD, { hostId: 'ssh:conn-1' }),
        [orphanKey]: meta(OLD),
        [wslKey]: meta(OLD)
      },
      worktreeLineageById: { [deadKey]: { parentWorktreeId: liveKey } }
    })

    const store = await createStore()
    const kept = Object.keys(store.getAllWorktreeMeta())

    expect(kept).toContain(liveKey) // path exists
    expect(kept).toContain(recentKey) // inside the grace window
    expect(kept).toContain(sshKey) // SSH repo: remote paths never checked locally
    expect(kept).toContain(remoteHostKey) // remote hostId on the meta itself
    expect(kept).toContain(wslKey) // WSL UNC path
    expect(kept).not.toContain(deadKey)
    expect(kept).not.toContain(orphanKey)
    expect(store.getWorktreeLineage(deadKey)).toBeUndefined()
  })

  it('never GCs folder-workspace instance metas — the meta IS the workspace', async () => {
    const OLD = Date.now() - 40 * 24 * 60 * 60 * 1000
    const folderInstanceKey = `r1::${join(testState.dir, 'gone-folder')}::workspace:11111111-1111-4111-8111-111111111111`
    writeDataFile({
      repos: [makeRepo({ kind: 'folder' })],
      worktreeMeta: {
        [folderInstanceKey]: { displayName: 'Session A', comment: '', lastActivityAt: OLD }
      }
    })

    const store = await createStore()
    expect(Object.keys(store.getAllWorktreeMeta())).toContain(folderInstanceKey)
  })

  it('never GCs Linux-style WSL worktree paths on Windows', async () => {
    const OLD = Date.now() - 40 * 24 * 60 * 60 * 1000
    const wslLinkedKey = 'r1::/home/user/gone-worktree'
    writeDataFile({
      repos: [makeRepo()],
      worktreeMeta: {
        [wslLinkedKey]: { displayName: '', comment: '', lastActivityAt: OLD }
      }
    })

    await withPlatform('win32', async () => {
      const store = await createStore()
      expect(Object.keys(store.getAllWorktreeMeta())).toContain(wslLinkedKey)
    })
  })

  it.each([null, [], 5])('repairs a corrupt worktreeMeta map (%#)', async (worktreeMeta) => {
    writeDataFile({ worktreeMeta })
    const store = await createStore()
    expect(store.getAllWorktreeMeta()).toEqual({})
    store.flush()
    expect((readDataFile() as PersistedState).worktreeMeta).toEqual({})
  })

  // ── GitHub cache sidecar ───────────────────────────────────────────

  it('cache refreshes never rewrite the durable state file', async () => {
    vi.useFakeTimers()
    try {
      const store = await createStore()
      store.updateUI({ sidebarWidth: 411 })
      vi.advanceTimersByTime(1000)
      await store.waitForPendingWrite()
      const inoBefore = statSync(dataFile()).ino
      expect((readDataFile() as { githubCache?: unknown }).githubCache).toBeUndefined()

      store.setGitHubCache({ pr: { 'o/r#1': { fetchedAt: 123 } as never }, issue: {} })
      vi.advanceTimersByTime(6000)
      await store.waitForPendingWrite()

      expect(statSync(dataFile()).ino).toBe(inoBefore)
    } finally {
      vi.useRealTimers()
    }
  })

  it('snapshots the cache at flush and seeds the next Store from the sidecar', async () => {
    const store = await createStore()
    store.setGitHubCache({ pr: { 'o/r#7': { fetchedAt: 7 } as never }, issue: {} })
    store.flush()
    expect(existsSync(join(testState.dir, 'orca-github-cache.json'))).toBe(true)

    const restarted = await createStore()
    expect(restarted.getGitHubCache().pr['o/r#7']).toEqual({ fetchedAt: 7 })
  })

  it('keeps GitHub cache sidecars scoped to explicit profile data files', async () => {
    const profileADir = join(testState.dir, 'profiles', 'a')
    const profileBDir = join(testState.dir, 'profiles', 'b')
    const profileADataFile = join(profileADir, 'orca-data.json')
    const profileBDataFile = join(profileBDir, 'orca-data.json')
    mkdirSync(profileADir, { recursive: true })
    mkdirSync(profileBDir, { recursive: true })

    vi.resetModules()
    const { Store, initDataPath } = await import('./persistence')
    initDataPath()
    const profileAStore = new Store({ dataFile: profileADataFile })
    profileAStore.setGitHubCache({ pr: { 'o/r#a': { fetchedAt: 10 } as never }, issue: {} })
    profileAStore.flush()

    const profileBStore = new Store({ dataFile: profileBDataFile })
    expect(profileBStore.getGitHubCache().pr['o/r#a']).toBeUndefined()
    profileBStore.setGitHubCache({ pr: { 'o/r#b': { fetchedAt: 20 } as never }, issue: {} })
    profileBStore.flush()

    const restartedProfileA = new Store({ dataFile: profileADataFile })
    const restartedProfileB = new Store({ dataFile: profileBDataFile })
    expect(restartedProfileA.getGitHubCache().pr['o/r#a']).toEqual({ fetchedAt: 10 })
    expect(restartedProfileA.getGitHubCache().pr['o/r#b']).toBeUndefined()
    expect(restartedProfileB.getGitHubCache().pr['o/r#b']).toEqual({ fetchedAt: 20 })
  })

  it('keeps a legacy in-file cache as the seed and strips it from disk', async () => {
    writeDataFile({ githubCache: { pr: { legacy: { fetchedAt: 1 } }, issue: {} } })

    const store = await createStore()
    expect(store.getGitHubCache().pr.legacy).toEqual({ fetchedAt: 1 })

    // The legacy key marks the state dirty at load; the next write drops it.
    store.flush()
    expect((readDataFile() as { githubCache?: unknown }).githubCache).toBeUndefined()
  })
})
