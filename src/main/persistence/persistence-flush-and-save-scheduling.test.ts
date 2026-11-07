import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  closeTestStores,
  createSqliteTestStore,
  testState,
  createStore,
  withPlatform,
  writeDataFile,
  readDataFile,
  makeRepo
} from './persistence-test-harness'
import { makeTerminalTab, TEST_LEAF_1 } from './persistence-session-fixtures'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { WorkspaceSessionState } from '../../shared/workspace-session/workspace-session-state-types'
import { _resetTracerForTests } from '../observability/tracer'
import { _resetPtyBindingSpanSamplingForTests } from './loading-store/pty-binding-span'

const { loadUserSshConfigMock, sshConfigHostsToTargetsMock } = vi.hoisted(() => ({
  loadUserSshConfigMock: vi.fn(),
  sshConfigHostsToTargetsMock: vi.fn()
}))

vi.mock('../ssh/config/ssh-config-parser', () => ({
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

vi.mock('../telemetry/client', () => ({
  track: trackMock
}))

vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: getCohortAtEmitMock
}))

describe('Store', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
    trackMock.mockReset()
    getCohortAtEmitMock.mockReset()
    getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    _resetPtyBindingSpanSamplingForTests()
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('durably commits an exact JSON operation before a following microtask changes generation', async () => {
    const store = await createStore()
    const originalTabId = store.getWorkspaceSession().activeTabId
    await store.runDurableMutation(() => {
      store.updateSettings({ theme: 'dark' })
      queueMicrotask(() => {
        store.setWorkspaceSession({ ...store.getWorkspaceSession(), activeTabId: 'newer-tab' })
      })
      return { value: undefined }
    })
    expect(readDataFile()).toMatchObject({
      settings: { theme: 'dark' },
      workspaceSession: { activeTabId: originalTabId }
    })
    expect(store.getWorkspaceSession().activeTabId).toBe('newer-tab')
    await store.flushPendingOrThrowAsync()
    expect(readDataFile()).toHaveProperty(['workspaceSession', 'activeTabId'], 'newer-tab')
    store.freezeWrites()
  })

  it('bounds save postponement under sustained mutation bursts (max-wait)', async () => {
    vi.useFakeTimers()
    try {
      const store = await createStore()
      // Keep resetting debounce past max-wait to verify sustained mutations still reach disk.
      let width = 400
      for (let i = 0; i < 11; i++) {
        store.updateUI({ sidebarWidth: width++ })
        vi.advanceTimersByTime(500)
      }
      await store.waitForPendingWrite()

      expect(existsSync(join(testState.dir, 'profile-state.db'))).toBe(true)
      const persisted = readDataFile() as { ui: { sidebarWidth: number } }
      expect(persisted.ui.sidebarWidth).toBeGreaterThanOrEqual(400)
    } finally {
      vi.useRealTimers()
    }
  })

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

    expect(kept).toContain(liveKey)
    expect(kept).toContain(recentKey)
    expect(kept).toContain(sshKey)
    expect(kept).toContain(remoteHostKey)
    expect(kept).toContain(wslKey)
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

  it('keeps GitHub cache sidecars scoped to explicit profile data files', async () => {
    const profileADir = join(testState.dir, 'profiles', 'a')
    const profileBDir = join(testState.dir, 'profiles', 'b')
    const profileADataFile = join(profileADir, 'orca-data.json')
    const profileBDataFile = join(profileBDir, 'orca-data.json')
    mkdirSync(profileADir, { recursive: true })
    mkdirSync(profileBDir, { recursive: true })

    vi.resetModules()
    const { Store } = await import('./loading-store/store')
    const { initDataPath } = await import('./loading-store/user-data-path')
    initDataPath()
    const profileAStore = createSqliteTestStore(Store, { dataFile: profileADataFile })
    profileAStore.setGitHubCache({ pr: { 'o/r#a': { fetchedAt: 10 } as never }, issue: {} })
    profileAStore.flush()

    const profileBStore = createSqliteTestStore(Store, { dataFile: profileBDataFile })
    expect(profileBStore.getGitHubCache().pr['o/r#a']).toBeUndefined()
    profileBStore.setGitHubCache({ pr: { 'o/r#b': { fetchedAt: 20 } as never }, issue: {} })
    profileBStore.flush()

    const restartedProfileA = createSqliteTestStore(Store, { dataFile: profileADataFile })
    const restartedProfileB = createSqliteTestStore(Store, { dataFile: profileBDataFile })
    expect(restartedProfileA.getGitHubCache().pr['o/r#a']).toEqual({ fetchedAt: 10 })
    expect(restartedProfileA.getGitHubCache().pr['o/r#b']).toBeUndefined()
    expect(restartedProfileB.getGitHubCache().pr['o/r#b']).toEqual({ fetchedAt: 20 })
  })

  describe('persistPtyBinding fast lane', () => {
    const WORKTREE = 'repo1::/worktree'
    const binding = { worktreeId: WORKTREE, tabId: 'tab1', leafId: TEST_LEAF_1, ptyId: 'pty-1' }
    const paneKey = `tab1:${TEST_LEAF_1}`

    const boundSession = (
      overrides: Partial<WorkspaceSessionState> = {}
    ): WorkspaceSessionState => ({
      ...getDefaultWorkspaceSession(),
      activeRepoId: 'repo1',
      activeWorktreeId: WORKTREE,
      activeTabId: 'tab1',
      tabsByWorktree: {
        [WORKTREE]: [makeTerminalTab({ id: 'tab1', worktreeId: WORKTREE, ptyId: 'pty-1' })]
      },
      terminalLayoutsByTabId: {
        tab1: {
          root: { type: 'leaf', leafId: TEST_LEAF_1 },
          activeLeafId: TEST_LEAF_1,
          expandedLeafId: null,
          ptyIdsByLeafId: { [TEST_LEAF_1]: 'pty-1' }
        }
      },
      ...overrides
    })

    const runtimeCounters = (store: ReturnType<typeof createStore>) => {
      const runtime = store['runtime']
      return {
        writeGeneration: runtime.writeGeneration,
        lastDurableWriteGeneration: runtime.lastDurableWriteGeneration
      }
    }

    afterEach(async () => {
      _resetTracerForTests()
    })

    it('falls through on an incarnation change and persists the new incarnation', async () => {
      const store = await createStore()
      store.setWorkspaceSession(boundSession())
      await store.persistPtyBinding({ ...binding, incarnationId: 'a' })
      const durableGenerationBefore = runtimeCounters(store).lastDurableWriteGeneration

      expect(await store.persistPtyBinding({ ...binding, incarnationId: 'b' })).toBe(true)

      expect(runtimeCounters(store).lastDurableWriteGeneration).toBeGreaterThan(
        durableGenerationBefore
      )
      expect(readDataFile()).toHaveProperty(
        ['workspaceSession', 'terminalPtyIncarnationsByPaneKey', paneKey],
        'b'
      )
    })

    it('does not acknowledge an unpersisted binding published after the final flush', async () => {
      const store = await createStore()
      store.setWorkspaceSession(boundSession())
      await store.persistPtyBinding(binding)
      await store.flushAsync()

      const next = boundSession()
      next.tabsByWorktree[WORKTREE][0].ptyId = 'pty-after-quit'
      next.terminalLayoutsByTabId.tab1.ptyIdsByLeafId = { [TEST_LEAF_1]: 'pty-after-quit' }
      expect(() => store.setWorkspaceSession(next)).toThrow('finalization')
      Object.assign(store.getWorkspaceSession(), next)
      expect(store.getWorkspaceSession().tabsByWorktree[WORKTREE][0].ptyId).toBe('pty-after-quit')

      await expect(
        store.persistPtyBinding({ ...binding, ptyId: 'pty-after-quit' })
      ).rejects.toThrow('Cannot mutate finalized profile persistence')
      expect(readDataFile()).toHaveProperty(
        ['workspaceSession', 'tabsByWorktree', WORKTREE, '0', 'ptyId'],
        'pty-1'
      )
    })

    it.each([undefined, 'ssh:ssh-1', 'runtime:runtime-1'])(
      'flushes unrelated dirty state once, then skips unchanged reattachments on %s',
      async (hostId) => {
        const store = await createStore()
        store.setWorkspaceSession(boundSession(), hostId)
        expect(await store.persistPtyBinding(binding, hostId)).toBe(true)
        store.addRepo(makeRepo({ id: 'r-dirty', path: '/dirty' }))
        const durableGenerationBefore = runtimeCounters(store).lastDurableWriteGeneration

        expect(await store.persistPtyBinding(binding, hostId)).toBe(true)
        expect(await store.persistPtyBinding(binding, hostId)).toBe(true)

        expect(runtimeCounters(store).lastDurableWriteGeneration).toBeGreaterThan(
          durableGenerationBefore
        )
        expect(readDataFile()).toMatchObject({
          repos: expect.arrayContaining([expect.objectContaining({ id: 'r-dirty' })])
        })
      }
    )

    it('flushes a changed pty for a pane whose old binding was durable', async () => {
      const store = await createStore()
      store.setWorkspaceSession(boundSession())
      await store.persistPtyBinding(binding)
      store.addRepo(makeRepo({ id: 'r-dirty', path: '/dirty' }))
      const durableGenerationBefore = runtimeCounters(store).lastDurableWriteGeneration

      expect(await store.persistPtyBinding({ ...binding, ptyId: 'pty-next' })).toBe(true)

      expect(runtimeCounters(store).lastDurableWriteGeneration).toBeGreaterThan(
        durableGenerationBefore
      )
      expect(readDataFile()).toHaveProperty(
        ['workspaceSession', 'terminalLayoutsByTabId', 'tab1', 'ptyIdsByLeafId', TEST_LEAF_1],
        'pty-next'
      )
    })
  })
})
