import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getDefaultWorkspaceSession } from '../shared/constants'
import { testState, createStore, makeTerminalTab } from './persistence-test-harness'
import { TEST_LEAF_1, TEST_LEAF_2 } from './persistence-session-fixtures'

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
  it('adds a missing split leaf to the durable root when a new pane spawns before layout debounce', async () => {
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
            ptyId: 'pty-1'
          }
        ]
      },
      terminalLayoutsByTabId: {
        tab1: {
          root: { type: 'leaf', leafId: TEST_LEAF_1 },
          activeLeafId: TEST_LEAF_1,
          expandedLeafId: null,
          ptyIdsByLeafId: { [TEST_LEAF_1]: 'pty-1' }
        }
      }
    })

    store.persistPtyBinding({
      worktreeId: 'wt1',
      tabId: 'tab1',
      leafId: TEST_LEAF_2,
      ptyId: 'pty-2'
    })

    const layout = store.getWorkspaceSession().terminalLayoutsByTabId.tab1
    expect(layout.root).toEqual({
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: TEST_LEAF_1 },
      second: { type: 'leaf', leafId: TEST_LEAF_2 }
    })
    expect(layout.activeLeafId).toBe(TEST_LEAF_2)
    expect(layout.ptyIdsByLeafId).toEqual({
      [TEST_LEAF_1]: 'pty-1',
      [TEST_LEAF_2]: 'pty-2'
    })

    const reloaded = await createStore()
    expect(reloaded.getWorkspaceSession().terminalLayoutsByTabId.tab1.ptyIdsByLeafId).toEqual({
      [TEST_LEAF_1]: 'pty-1',
      [TEST_LEAF_2]: 'pty-2'
    })
  })

  it('advances host topology when a live spawn adds a split leaf after retirement', async () => {
    const store = await createStore()
    store.setWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {
        wt1: [makeTerminalTab({ id: 'tab1', worktreeId: 'wt1', ptyId: 'pty-1' })]
      },
      terminalLayoutsByTabId: {
        tab1: {
          root: { type: 'leaf', leafId: TEST_LEAF_1 },
          activeLeafId: TEST_LEAF_1,
          expandedLeafId: null,
          ptyIdsByLeafId: { [TEST_LEAF_1]: 'pty-1' }
        }
      },
      terminalTopologyRevisionByRepoId: { wt1: 1 }
    })

    store.persistPtyBinding({
      worktreeId: 'wt1',
      tabId: 'tab1',
      leafId: TEST_LEAF_2,
      ptyId: 'pty-2'
    })

    const session = store.getWorkspaceSession()
    expect(session.terminalTopologyRevisionByRepoId?.wt1).toBe(2)
    expect(session.terminalLayoutsByTabId.tab1.ptyIdsByLeafId).toEqual({
      [TEST_LEAF_1]: 'pty-1',
      [TEST_LEAF_2]: 'pty-2'
    })
  })

  it('keeps worktree deletion authoritative against stale writes and later same-path reuse', async () => {
    const store = await createStore()
    store.setWorktreeMeta('wt1', { displayName: 'Worktree' })
    store.setWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {
        wt1: [makeTerminalTab({ id: 'old-tab', worktreeId: 'wt1', ptyId: 'old-pty' })]
      },
      terminalLayoutsByTabId: {
        'old-tab': {
          root: { type: 'leaf', leafId: TEST_LEAF_1 },
          activeLeafId: TEST_LEAF_1,
          expandedLeafId: null,
          ptyIdsByLeafId: { [TEST_LEAF_1]: 'old-pty' }
        }
      },
      terminalPtyIncarnationsByPaneKey: {
        [`old-tab:${TEST_LEAF_1}`]: 'old-incarnation'
      },
      terminalTopologyRevisionByRepoId: { wt1: 1 }
    })
    const stale = structuredClone(store.getWorkspaceSession())

    store.removeWorktreeMeta('wt1')

    expect(store.getWorkspaceSession().tabsByWorktree.wt1).toBeUndefined()
    expect(store.getWorkspaceSession().terminalLayoutsByTabId['old-tab']).toBeUndefined()
    expect(store.getWorkspaceSession().terminalTopologyRevisionByRepoId?.wt1).toBe(2)

    store.setWorkspaceSession(stale)
    expect(store.getWorkspaceSession().tabsByWorktree.wt1).toEqual([])

    store.persistPtyBinding({
      worktreeId: 'wt1',
      tabId: 'fresh-tab',
      leafId: TEST_LEAF_2,
      ptyId: 'fresh-pty',
      incarnationId: 'fresh-incarnation'
    })
    expect(store.getWorkspaceSession().tabsByWorktree.wt1).toEqual([
      expect.objectContaining({ id: 'fresh-tab', ptyId: 'fresh-pty' })
    ])
    expect(store.getWorkspaceSession().terminalTopologyRevisionByRepoId?.wt1).toBe(3)
  })

  it('fences a delayed terminal snapshot after an empty worktree is deleted', async () => {
    const store = await createStore()
    const worktreeId = 'repo::/empty-worktree'
    store.setWorktreeMeta(worktreeId, { displayName: 'Empty worktree' })
    const stale = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {
        [worktreeId]: [makeTerminalTab({ id: 'late-tab', worktreeId, ptyId: 'late-pty' })]
      }
    }

    store.removeWorktreeMeta(worktreeId)
    expect(store.getWorkspaceSession().terminalTopologyRevisionByRepoId?.repo).toBe(1)

    store.setWorkspaceSession(stale)

    expect(store.getWorkspaceSession().tabsByWorktree[worktreeId]).toEqual([])
  })

  it('advances deletion authority when only a legacy retirement fence existed', async () => {
    const store = await createStore()
    const worktreeId = 'repo::/legacy-tombstone'
    store.setWorktreeMeta(worktreeId, { displayName: 'Legacy worktree' })
    store.setWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      terminalSurfaceTombstonesByPaneKey: {
        'old-tab:old-leaf': {
          worktreeId,
          parentTabId: 'old-tab',
          leafId: 'old-leaf',
          ptyId: 'old-pty',
          incarnationId: 'old-incarnation',
          retiredAt: 1
        }
      }
    })
    const revisionBeforeDelete =
      store.getWorkspaceSession().terminalTopologyRevisionByRepoId?.repo ?? 0

    store.removeWorktreeMeta(worktreeId)

    expect(store.getWorkspaceSession().terminalTopologyRevisionByRepoId?.repo).toBe(
      revisionBeforeDelete + 1
    )
  })

  it('enforces one repo epoch across siblings and admits a fresh sibling spawn', async () => {
    const store = await createStore()
    const worktreeA = 'repo::/worktree-a'
    const worktreeB = 'repo::/worktree-b'
    store.setWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {
        [worktreeA]: [makeTerminalTab({ id: 'tab-a', worktreeId: worktreeA, ptyId: 'pty-a' })],
        [worktreeB]: [makeTerminalTab({ id: 'tab-b', worktreeId: worktreeB, ptyId: 'pty-b' })]
      },
      terminalTopologyRevisionByRepoId: { repo: 1 }
    })

    store.setWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {
        [worktreeB]: [makeTerminalTab({ id: 'stale-tab', worktreeId: worktreeB })]
      }
    })

    expect(store.getWorkspaceSession().tabsByWorktree[worktreeA]?.[0]?.id).toBe('tab-a')
    expect(store.getWorkspaceSession().tabsByWorktree[worktreeB]?.[0]?.id).toBe('tab-b')

    store.persistPtyBinding({
      worktreeId: worktreeB,
      tabId: 'fresh-tab',
      leafId: TEST_LEAF_1,
      ptyId: 'fresh-pty'
    })

    expect(store.getWorkspaceSession().tabsByWorktree[worktreeB].map((tab) => tab.id)).toEqual([
      'tab-b',
      'fresh-tab'
    ])
    expect(store.getWorkspaceSession().terminalTopologyRevisionByRepoId?.repo).toBe(2)
  })

  it('keeps one deletion watermark for many historical worktrees in the same repo', async () => {
    const store = await createStore()

    for (let index = 0; index < 25; index += 1) {
      const worktreeId = `repo::/worktree-${index}`
      store.setWorktreeMeta(worktreeId, { displayName: `Worktree ${index}` })
      store.persistPtyBinding({
        worktreeId,
        tabId: `tab-${index}`,
        leafId: TEST_LEAF_1,
        ptyId: `pty-${index}`
      })
      store.removeWorktreeMeta(worktreeId)
    }

    const session = store.getWorkspaceSession()
    expect(Object.keys(session.terminalTopologyRevisionByRepoId ?? {})).toEqual(['repo'])
    expect(session.tabsByWorktree).toEqual({})
  })

  it('does not remove colliding worktree ids from other execution-host partitions', async () => {
    const store = await createStore()
    const worktreeId = 'repo::/same-path'
    store.setWorktreeMeta(worktreeId, { displayName: 'Local worktree' })
    store.setWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {
        [worktreeId]: [makeTerminalTab({ id: 'local-tab', worktreeId })]
      }
    })
    store.setWorkspaceSession(
      {
        ...getDefaultWorkspaceSession(),
        tabsByWorktree: {
          [worktreeId]: [makeTerminalTab({ id: 'remote-a-tab', worktreeId })]
        }
      },
      'runtime:env-a'
    )
    store.setWorkspaceSession(
      {
        ...getDefaultWorkspaceSession(),
        tabsByWorktree: {
          [worktreeId]: [makeTerminalTab({ id: 'remote-b-tab', worktreeId })]
        }
      },
      'runtime:env-b'
    )

    store.removeWorktreeMeta(worktreeId)

    expect(store.getWorkspaceSession().tabsByWorktree[worktreeId]).toBeUndefined()
    expect(store.getWorkspaceSession('runtime:env-a').tabsByWorktree[worktreeId]?.[0]?.id).toBe(
      'remote-a-tab'
    )
    expect(store.getWorkspaceSession('runtime:env-b').tabsByWorktree[worktreeId]?.[0]?.id).toBe(
      'remote-b-tab'
    )
  })

  it('preserves a sync-persisted UUID root when a stale empty layout write arrives', async () => {
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

    store.persistPtyBinding({
      worktreeId: 'wt1',
      tabId: 'tab1',
      leafId: TEST_LEAF_1,
      ptyId: 'daemon-pty'
    })

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
          expandedLeafId: null,
          ptyIdsByLeafId: {}
        }
      }
    })

    const session = store.getWorkspaceSession()
    expect(session.tabsByWorktree.wt1[0].ptyId).toBe('daemon-pty')
    expect(session.terminalLayoutsByTabId.tab1).toEqual({
      root: { type: 'leaf', leafId: TEST_LEAF_1 },
      activeLeafId: TEST_LEAF_1,
      expandedLeafId: null,
      ptyIdsByLeafId: { [TEST_LEAF_1]: 'daemon-pty' }
    })
  })
})
