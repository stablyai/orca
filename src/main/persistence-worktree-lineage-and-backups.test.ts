import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { writeFileSync, readFileSync, rmSync, mkdtempSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Repo } from '../shared/repo-types'
import { folderWorkspaceKey, worktreeWorkspaceKey } from '../shared/workspace-scope'
import {
  testState,
  createStore,
  dataFile,
  writeDataFile,
  readDataFile,
  makeRepo,
  makeWorktreeLineage,
  makeWorkspaceLineage
} from './persistence-test-harness'

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
  // ── getAllWorktreeMeta ─────────────────────────────────────────────

  it('getAllWorktreeMeta returns all entries', async () => {
    const store = await createStore()
    store.setWorktreeMeta('a', { displayName: 'A' })
    store.setWorktreeMeta('b', { displayName: 'B' })
    const all = store.getAllWorktreeMeta()
    expect(Object.keys(all)).toHaveLength(2)
    expect(all['a'].displayName).toBe('A')
    expect(all['b'].displayName).toBe('B')
  })

  // ── removeWorktreeMeta ─────────────────────────────────────────────

  it('removeWorktreeMeta deletes a single entry', async () => {
    const store = await createStore()
    store.setWorktreeMeta('a', { displayName: 'A' })
    store.setWorktreeMeta('b', { displayName: 'B' })
    store.removeWorktreeMeta('a')
    expect(store.getWorktreeMeta('a')).toBeUndefined()
    expect(store.getWorktreeMeta('b')).toBeDefined()
  })

  it('stores and removes worktree lineage independently from metadata', async () => {
    const store = await createStore()
    const lineage = makeWorktreeLineage()

    store.setWorktreeMeta(lineage.worktreeId, { displayName: 'child' })
    store.setWorktreeLineage(lineage.worktreeId, lineage)

    expect(store.getWorktreeLineage(lineage.worktreeId)).toEqual(lineage)
    expect(store.getAllWorktreeLineage()).toEqual({ [lineage.worktreeId]: lineage })

    store.removeWorktreeLineage(lineage.worktreeId)

    expect(store.getWorktreeLineage(lineage.worktreeId)).toBeUndefined()
    expect(store.getWorktreeMeta(lineage.worktreeId)).toBeDefined()
  })

  it('removeWorktreeMeta deletes that worktree lineage entry', async () => {
    const store = await createStore()
    const lineage = makeWorktreeLineage()

    store.setWorktreeMeta(lineage.worktreeId, { displayName: 'child' })
    store.setWorktreeLineage(lineage.worktreeId, lineage)

    store.removeWorktreeMeta(lineage.worktreeId)

    expect(store.getWorktreeMeta(lineage.worktreeId)).toBeUndefined()
    expect(store.getWorktreeLineage(lineage.worktreeId)).toBeUndefined()
  })

  it('stores workspace lineage and removes it with the child worktree metadata', async () => {
    const store = await createStore()
    const lineage = makeWorkspaceLineage()

    store.setWorktreeMeta('r1::/path/child', { displayName: 'child' })
    store.setWorkspaceLineage(lineage)

    expect(store.getWorkspaceLineage(lineage.childWorkspaceKey)).toEqual(lineage)
    expect(store.getAllWorkspaceLineage()).toEqual({ [lineage.childWorkspaceKey]: lineage })

    store.removeWorktreeMeta('r1::/path/child')

    expect(store.getWorkspaceLineage(lineage.childWorkspaceKey)).toBeUndefined()
  })

  it('removeFolderWorkspace deletes child workspace lineage for that folder parent', async () => {
    const store = await createStore()
    const group = store.createProjectGroup({
      name: 'Platform',
      parentPath: '/workspace/platform',
      createdFrom: 'folder-scan'
    })
    const workspace = store.createFolderWorkspace({
      projectGroupId: group.id,
      name: 'Folder parent'
    })
    const folderLineage = makeWorkspaceLineage({
      parentWorkspaceKey: folderWorkspaceKey(workspace.id)
    })
    const unrelatedLineage = makeWorkspaceLineage({
      childWorkspaceKey: worktreeWorkspaceKey('r2::/other-child'),
      parentWorkspaceKey: folderWorkspaceKey('other-folder')
    })

    store.setWorkspaceLineage(folderLineage)
    store.setWorkspaceLineage(unrelatedLineage)

    store.removeFolderWorkspace(workspace.id)

    expect(store.getWorkspaceLineage(folderLineage.childWorkspaceKey)).toBeUndefined()
    expect(store.getWorkspaceLineage(unrelatedLineage.childWorkspaceKey)).toEqual(unrelatedLineage)
  })

  // ── Live Claude PTY session ids (STA-1246) ─────────────────────────

  describe('mobileClientTabSelectionsByDeviceId', () => {
    it('persists device tab selections across reloads and drops malformed payloads', async () => {
      const store = await createStore()
      // Registered on purpose: rows owned by an unregistered repo id are swept as orphans on load.
      store.addRepo(makeRepo({ id: 'repo-1', path: '/repo-1' }))
      store.setMobileClientTabSelections({
        'device-a': {
          'repo-1::/tmp/wt': { activeTabId: 'tab-1', activeGroupId: 'g1', activeTabIdByGroupId: {} }
        }
      })
      store.flush()

      const reloaded = await createStore()
      expect(reloaded.getMobileClientTabSelections()['device-a']?.['repo-1::/tmp/wt']).toEqual({
        activeTabId: 'tab-1',
        activeGroupId: 'g1',
        activeTabIdByGroupId: {}
      })

      writeDataFile({ mobileClientTabSelectionsByDeviceId: { 'device-a': 'corrupt' } })
      const corrupted = await createStore()
      expect(corrupted.getMobileClientTabSelections()).toEqual({})
    })

    it('prunes selections for a removed repo worktree', async () => {
      const store = await createStore()
      store.addRepo(makeRepo())
      store.addRepo(makeRepo({ id: 'other-repo', path: '/other-repo' }))
      store.setMobileClientTabSelections({
        'device-a': {
          'r1::/tmp/wt': {
            activeTabId: 'tab-1',
            activeGroupId: null,
            activeTabIdByGroupId: {}
          },
          'other-repo::/tmp/wt': {
            activeTabId: 'tab-2',
            activeGroupId: null,
            activeTabIdByGroupId: {}
          }
        }
      })

      store.removeProject('r1')
      store.flush()

      expect(store.getMobileClientTabSelections()['device-a']).toEqual({
        'other-repo::/tmp/wt': {
          activeTabId: 'tab-2',
          activeGroupId: null,
          activeTabIdByGroupId: {}
        }
      })
      const reloaded = await createStore()
      expect(reloaded.getMobileClientTabSelections()['device-a']).toEqual({
        'other-repo::/tmp/wt': {
          activeTabId: 'tab-2',
          activeGroupId: null,
          activeTabIdByGroupId: {}
        }
      })
    })

    it('prunes selections when a folder workspace is removed directly or with its group', async () => {
      const store = await createStore()
      const directGroup = store.createProjectGroup({
        name: 'Direct',
        parentPath: '/tmp/direct',
        createdFrom: 'manual'
      })
      const directWorkspace = store.createFolderWorkspace({
        projectGroupId: directGroup.id,
        name: 'Direct workspace'
      })
      const cascadeGroup = store.createProjectGroup({
        name: 'Cascade',
        parentPath: '/tmp/cascade',
        createdFrom: 'manual'
      })
      const cascadeWorkspace = store.createFolderWorkspace({
        projectGroupId: cascadeGroup.id,
        name: 'Cascade workspace'
      })
      store.setMobileClientTabSelections({
        'device-a': {
          [folderWorkspaceKey(directWorkspace.id)]: {
            activeTabId: 'tab-direct',
            activeGroupId: null,
            activeTabIdByGroupId: {}
          },
          [folderWorkspaceKey(cascadeWorkspace.id)]: {
            activeTabId: 'tab-cascade',
            activeGroupId: null,
            activeTabIdByGroupId: {}
          }
        }
      })

      store.removeFolderWorkspace(directWorkspace.id)
      store.deleteProjectGroup(cascadeGroup.id)
      store.flush()

      const reloaded = await createStore()
      expect(reloaded.getMobileClientTabSelections()).toEqual({})
    })
  })

  describe('claudeLivePtySessionIds', () => {
    it('persists added ids across reloads and removes them durably', async () => {
      const store = await createStore()

      store.addClaudeLivePtySessionId('claude-session-1')
      store.addClaudeLivePtySessionId('claude-session-2')
      store.addClaudeLivePtySessionId('claude-session-1')

      expect(store.getClaudeLivePtySessionIds()).toEqual(['claude-session-1', 'claude-session-2'])

      const reloaded = await createStore()
      expect(reloaded.getClaudeLivePtySessionIds()).toEqual([
        'claude-session-1',
        'claude-session-2'
      ])

      reloaded.removeClaudeLivePtySessionId('claude-session-1')
      reloaded.flush()

      const reloadedAgain = await createStore()
      expect(reloadedAgain.getClaudeLivePtySessionIds()).toEqual(['claude-session-2'])
    })

    it('drops malformed persisted entries on load', async () => {
      writeDataFile({
        schemaVersion: 1,
        claudeLivePtySessionIds: ['valid-id', '', 42, null, 'valid-id', 'x'.repeat(513)]
      })

      const store = await createStore()

      expect(store.getClaudeLivePtySessionIds()).toEqual(['valid-id'])
    })

    it('keeps the newest ids when an oversized persisted list is loaded', async () => {
      writeDataFile({
        schemaVersion: 1,
        claudeLivePtySessionIds: Array.from({ length: 205 }, (_, index) => `claude-${index}`)
      })

      const store = await createStore()

      const ids = store.getClaudeLivePtySessionIds()
      expect(ids).toHaveLength(200)
      expect(ids[0]).toBe('claude-5')
      expect(ids[199]).toBe('claude-204')
    })

    it('caps the persisted id list', async () => {
      const store = await createStore()
      for (let index = 0; index < 205; index += 1) {
        store.addClaudeLivePtySessionId(`claude-session-${index}`)
      }

      const ids = store.getClaudeLivePtySessionIds()
      expect(ids).toHaveLength(200)
      expect(ids[0]).toBe('claude-session-5')
      expect(ids[199]).toBe('claude-session-204')
    })
  })

  // ── Rolling backups (issue #1158) ──────────────────────────────────

  describe('rolling backups', () => {
    function backupFile(index: number): string {
      return `${dataFile()}.bak.${index}`
    }

    function readBackup(index: number): { repos: Repo[] } {
      return JSON.parse(readFileSync(backupFile(index), 'utf-8'))
    }

    function advanceMockedTime(advanceFn: () => void, ms: number): void {
      vi.setSystemTime(new Date(Date.now() + ms))
      advanceFn()
    }

    it('snapshots the just-written file to .bak.0 on the very first write', async () => {
      const s = await createStore()
      s.addRepo(makeRepo())
      s.flush()
      expect(existsSync(dataFile())).toBe(true)
      expect(existsSync(backupFile(0))).toBe(true)
      expect(readBackup(0).repos.map((r) => r.id)).toEqual(['r1'])
    })

    it('rotates older .bak.0 to .bak.1 when the interval elapses', async () => {
      vi.useFakeTimers()
      try {
        const first = await createStore()
        first.addRepo(makeRepo({ id: 'r1' }))
        first.flush()
        expect(readBackup(0).repos.map((r) => r.id)).toEqual(['r1'])

        vi.setSystemTime(new Date(Date.now() + 61 * 60 * 1000))

        const second = await createStore()
        second.addRepo(makeRepo({ id: 'r2', path: '/repo2' }))
        second.flush()

        const current = readDataFile() as { repos: Repo[] }
        expect(current.repos.map((r) => r.id).sort()).toEqual(['r1', 'r2'])
        expect(
          readBackup(0)
            .repos.map((r) => r.id)
            .sort()
        ).toEqual(['r1', 'r2'])
        expect(readBackup(1).repos.map((r) => r.id)).toEqual(['r1'])
      } finally {
        vi.useRealTimers()
      }
    })

    it('keeps at most 5 rotating backups', async () => {
      vi.useFakeTimers()
      try {
        writeDataFile({
          schemaVersion: 1,
          repos: [makeRepo({ id: 'seed' })],
          worktreeMeta: {},
          settings: {},
          ui: {},
          githubCache: { pr: {}, issue: {} },
          workspaceSession: {}
        })

        for (let i = 0; i < 6; i++) {
          vi.setSystemTime(new Date(Date.now() + 61 * 60 * 1000))
          const s = await createStore()
          s.addRepo(makeRepo({ id: `gen-${i}`, path: `/gen-${i}` }))
          s.flush()
        }

        for (let i = 0; i < 5; i++) {
          expect(existsSync(backupFile(i))).toBe(true)
        }
        expect(existsSync(backupFile(5))).toBe(false)
      } finally {
        vi.useRealTimers()
      }
    })

    it('does not rotate more than once per hour', async () => {
      vi.useFakeTimers()
      try {
        writeDataFile({
          schemaVersion: 1,
          repos: [makeRepo({ id: 'seed' })],
          worktreeMeta: {},
          settings: {},
          ui: {},
          githubCache: { pr: {}, issue: {} },
          workspaceSession: {}
        })

        const store = await createStore()
        store.addRepo(makeRepo({ id: 'after-seed' }))
        store.flush()

        const bak0After1 = readBackup(0)
        expect(bak0After1.repos.map((r) => r.id).sort()).toEqual(['after-seed', 'seed'])

        advanceMockedTime(
          () => {
            store.addRepo(makeRepo({ id: 'within-hour', path: '/within' }))
            store.flush()
          },
          5 * 60 * 1000
        )

        const bak0After2 = readBackup(0)
        expect(bak0After2.repos.map((r) => r.id).sort()).toEqual(['after-seed', 'seed'])
      } finally {
        vi.useRealTimers()
      }
    })

    it('does not rotate on the async write path within the 1-hour window', async () => {
      vi.useFakeTimers()
      try {
        writeDataFile({
          schemaVersion: 1,
          repos: [makeRepo({ id: 'seed' })],
          worktreeMeta: {},
          settings: {},
          ui: {},
          githubCache: { pr: {}, issue: {} },
          workspaceSession: {}
        })

        const store = await createStore()
        store.addRepo(makeRepo({ id: 'first-async' }))
        vi.advanceTimersByTime(1000)
        await store.waitForPendingWrite()

        const bak0AfterFirst = readBackup(0)
        expect(bak0AfterFirst.repos.map((r) => r.id).sort()).toEqual(['first-async', 'seed'])

        vi.setSystemTime(new Date(Date.now() + 5 * 60 * 1000))
        store.addRepo(makeRepo({ id: 'within-hour-async', path: '/within-async' }))
        vi.advanceTimersByTime(1000)
        await store.waitForPendingWrite()

        const bak0AfterSecond = readBackup(0)
        expect(bak0AfterSecond.repos.map((r) => r.id).sort()).toEqual(['first-async', 'seed'])
      } finally {
        vi.useRealTimers()
      }
    })

    it('rotates on the async write path after the 1-hour window elapses', async () => {
      vi.useFakeTimers()
      try {
        writeDataFile({
          schemaVersion: 1,
          repos: [makeRepo({ id: 'seed' })],
          worktreeMeta: {},
          settings: {},
          ui: {},
          githubCache: { pr: {}, issue: {} },
          workspaceSession: {}
        })

        const store = await createStore()
        store.addRepo(makeRepo({ id: 'first-async' }))
        vi.advanceTimersByTime(1000)
        await store.waitForPendingWrite()

        expect(
          readBackup(0)
            .repos.map((r) => r.id)
            .sort()
        ).toEqual(['first-async', 'seed'])

        vi.setSystemTime(new Date(Date.now() + 61 * 60 * 1000))
        store.addRepo(makeRepo({ id: 'after-hour-async', path: '/after-async' }))
        vi.advanceTimersByTime(1000)
        await store.waitForPendingWrite()

        expect(
          readBackup(0)
            .repos.map((r) => r.id)
            .sort()
        ).toEqual(['after-hour-async', 'first-async', 'seed'])
        expect(existsSync(backupFile(1))).toBe(true)
        expect(
          readBackup(1)
            .repos.map((r) => r.id)
            .sort()
        ).toEqual(['first-async', 'seed'])
      } finally {
        vi.useRealTimers()
      }
    })

    function writeBackup(index: number, data: unknown): void {
      mkdirSync(testState.dir, { recursive: true })
      writeFileSync(backupFile(index), JSON.stringify(data, null, 2), 'utf-8')
    }

    it('recovers from .bak.0 when the primary file is corrupt', async () => {
      mkdirSync(testState.dir, { recursive: true })
      writeFileSync(dataFile(), '{{{corrupt-json', 'utf-8')
      writeBackup(0, {
        schemaVersion: 1,
        repos: [makeRepo({ id: 'recovered' })],
        worktreeMeta: {},
        settings: {},
        ui: {},
        githubCache: { pr: {}, issue: {} },
        workspaceSession: {}
      })

      const store = await createStore()
      expect(store.getRepos().map((r) => r.id)).toEqual(['recovered'])
    })

    it('falls through to .bak.1 when both primary and .bak.0 are corrupt', async () => {
      mkdirSync(testState.dir, { recursive: true })
      writeFileSync(dataFile(), '{{{corrupt-json', 'utf-8')
      writeFileSync(backupFile(0), '{{also-corrupt', 'utf-8')
      writeBackup(1, {
        schemaVersion: 1,
        repos: [makeRepo({ id: 'from-bak1' })],
        worktreeMeta: {},
        settings: {},
        ui: {},
        githubCache: { pr: {}, issue: {} },
        workspaceSession: {}
      })

      const store = await createStore()
      expect(store.getRepos().map((r) => r.id)).toEqual(['from-bak1'])
    })

    it('falls back to defaults only when every backup is also unusable', async () => {
      mkdirSync(testState.dir, { recursive: true })
      writeFileSync(dataFile(), '{{{corrupt', 'utf-8')
      for (let i = 0; i < 5; i++) {
        writeFileSync(backupFile(i), `{{slot-${i}-corrupt`, 'utf-8')
      }

      const store = await createStore()
      expect(store.getRepos()).toEqual([])
    })

    it('uses .bak.0 even when primary file is missing entirely', async () => {
      mkdirSync(testState.dir, { recursive: true })
      writeBackup(0, {
        schemaVersion: 1,
        repos: [makeRepo({ id: 'rescued' })],
        worktreeMeta: {},
        settings: {},
        ui: {},
        githubCache: { pr: {}, issue: {} },
        workspaceSession: {}
      })

      const store = await createStore()
      expect(store.getRepos().map((r) => r.id)).toEqual(['rescued'])
    })

    it('still recovers repos/worktrees from a backup with corrupt workspaceSession', async () => {
      mkdirSync(testState.dir, { recursive: true })
      writeFileSync(dataFile(), '{{{corrupt', 'utf-8')
      writeBackup(0, {
        schemaVersion: 1,
        repos: [makeRepo({ id: 'survives' })],
        worktreeMeta: {},
        settings: { theme: 'dark' },
        ui: {},
        githubCache: { pr: {}, issue: {} },
        workspaceSession: { activeRepoId: 12345 }
      })

      const store = await createStore()
      expect(store.getRepos().map((r) => r.id)).toEqual(['survives'])
      expect(store.getSettings().theme).toBe('dark')
    })
  })

  // ── Concurrent write serialization (issue #1158) ───────────────────

  describe('concurrent write serialization', () => {
    it('chains debounced writes via pendingWrite so they run sequentially', async () => {
      vi.useFakeTimers()
      try {
        const store = await createStore()
        store.addRepo(makeRepo({ id: 'first' }))
        vi.advanceTimersByTime(1000)
        store.addRepo(makeRepo({ id: 'second', path: '/second' }))
        vi.advanceTimersByTime(1000)
        await store.waitForPendingWrite()

        const persisted = JSON.parse(readFileSync(dataFile(), 'utf-8')) as { repos: Repo[] }
        expect(persisted.repos.map((r) => r.id).sort()).toEqual(['first', 'second'])
      } finally {
        vi.useRealTimers()
      }
    })
  })
})
