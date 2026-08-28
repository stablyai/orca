import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getDefaultWorkspaceSession } from '../shared/constants'
import { testState, createStore, writeDataFile, makeTerminalTab } from './persistence-test-harness'
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
  it('remaps legacy SSH lease leaf ids by PTY when the layout is already normalized', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {},
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {
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
              ptyId: 'remote-pty'
            }
          ]
        },
        terminalLayoutsByTabId: {
          tab1: {
            root: { type: 'leaf', leafId: TEST_LEAF_1 },
            activeLeafId: TEST_LEAF_1,
            expandedLeafId: null,
            ptyIdsByLeafId: { [TEST_LEAF_1]: 'remote-pty' }
          }
        }
      },
      sshRemotePtyLeases: [
        {
          targetId: 'ssh-1',
          ptyId: 'remote-pty',
          worktreeId: 'wt1',
          tabId: 'tab1',
          leafId: 'pane:1',
          state: 'detached',
          createdAt: 1,
          updatedAt: 1
        }
      ]
    })

    const store = await createStore()
    expect(store.getSshRemotePtyLeases('ssh-1')[0].leafId).toBe(TEST_LEAF_1)
  })

  it('normalizes stale legacy session writes to prior UUID leaves before preserving bindings', async () => {
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
            ptyId: 'remote-pty'
          }
        ]
      },
      terminalLayoutsByTabId: {
        tab1: {
          root: { type: 'leaf', leafId: TEST_LEAF_1 },
          activeLeafId: TEST_LEAF_1,
          expandedLeafId: null,
          ptyIdsByLeafId: { [TEST_LEAF_1]: 'remote-pty' }
        }
      }
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
          root: { type: 'leaf', leafId: 'pane:1' },
          activeLeafId: 'pane:1',
          expandedLeafId: null,
          ptyIdsByLeafId: {}
        }
      }
    })

    const session = store.getWorkspaceSession()
    const layout = session.terminalLayoutsByTabId.tab1
    expect(layout.root).toEqual({ type: 'leaf', leafId: TEST_LEAF_1 })
    expect(layout.ptyIdsByLeafId).toEqual({ [TEST_LEAF_1]: 'remote-pty' })
    expect(session.tabsByWorktree.wt1[0].ptyId).toBe('remote-pty')
  })

  it('promotes an empty tab layout to a durable UUID root when persisting the first PTY binding', async () => {
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

    const session = store.getWorkspaceSession()
    expect(session.tabsByWorktree.wt1[0].ptyId).toBe('daemon-pty')
    expect(session.terminalLayoutsByTabId.tab1).toEqual({
      root: { type: 'leaf', leafId: TEST_LEAF_1 },
      activeLeafId: TEST_LEAF_1,
      expandedLeafId: null,
      ptyIdsByLeafId: { [TEST_LEAF_1]: 'daemon-pty' }
    })
  })

  it('admits a fresh host spawn after retirement while rejecting an older renderer topology', async () => {
    const store = await createStore()
    store.setWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      terminalTopologyRevisionByRepoId: { wt1: 1 }
    })

    store.persistPtyBinding({
      worktreeId: 'wt1',
      tabId: 'fresh-tab',
      leafId: TEST_LEAF_1,
      ptyId: 'fresh-pty',
      incarnationId: 'fresh-incarnation'
    })

    const admitted = structuredClone(store.getWorkspaceSession())
    expect(admitted.terminalTopologyRevisionByRepoId?.wt1).toBe(2)
    expect(admitted.tabsByWorktree.wt1).toEqual([
      expect.objectContaining({ id: 'fresh-tab', ptyId: 'fresh-pty' })
    ])

    store.setWorkspaceSession({
      ...admitted,
      tabsByWorktree: {
        ...admitted.tabsByWorktree,
        wt1: admitted.tabsByWorktree.wt1.map((tab) => ({
          ...tab,
          title: 'Fresh title',
          sortOrder: 7
        }))
      },
      terminalLayoutsByTabId: {
        ...admitted.terminalLayoutsByTabId,
        'fresh-tab': {
          ...admitted.terminalLayoutsByTabId['fresh-tab'],
          titlesByLeafId: { [TEST_LEAF_1]: 'Fresh pane title' }
        }
      }
    })
    expect(store.getWorkspaceSession().tabsByWorktree.wt1[0]).toMatchObject({
      id: 'fresh-tab',
      ptyId: 'fresh-pty',
      title: 'Fresh title',
      sortOrder: 7
    })
    expect(store.getWorkspaceSession().terminalLayoutsByTabId['fresh-tab'].titlesByLeafId).toEqual({
      [TEST_LEAF_1]: 'Fresh pane title'
    })

    store.setWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {
        wt1: [
          {
            id: 'retired-tab',
            worktreeId: 'wt1',
            title: 'Retired',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            ptyId: 'retired-pty'
          }
        ]
      },
      terminalLayoutsByTabId: {
        'retired-tab': {
          root: { type: 'leaf', leafId: TEST_LEAF_2 },
          activeLeafId: TEST_LEAF_2,
          expandedLeafId: null,
          ptyIdsByLeafId: { [TEST_LEAF_2]: 'retired-pty' }
        }
      },
      terminalPtyIncarnationsByPaneKey: {
        [`retired-tab:${TEST_LEAF_2}`]: 'retired-incarnation'
      },
      terminalTopologyRevisionByRepoId: { wt1: 1 }
    })

    const afterStaleWrite = store.getWorkspaceSession()
    expect(afterStaleWrite.tabsByWorktree.wt1).toEqual([
      expect.objectContaining({ id: 'fresh-tab', ptyId: 'fresh-pty' })
    ])
    expect(afterStaleWrite.terminalLayoutsByTabId['retired-tab']).toBeUndefined()
    expect(
      afterStaleWrite.terminalPtyIncarnationsByPaneKey?.[`retired-tab:${TEST_LEAF_2}`]
    ).toBeUndefined()
  })

  it('reconciles only the incarnation of an unchanged durable PTY binding', async () => {
    const store = await createStore()
    const paneKey = `tab1:${TEST_LEAF_1}`
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
      terminalPtyIncarnationsByPaneKey: { [paneKey]: 'inc-stale' }
    })

    expect(
      store.persistPtyBinding({
        worktreeId: 'wt1',
        tabId: 'tab1',
        leafId: TEST_LEAF_1,
        ptyId: 'pty-1',
        incarnationId: 'inc-live',
        expectedBinding: { ptyId: 'pty-1', incarnationId: 'inc-stale' }
      })
    ).toBe(true)

    expect(store.getWorkspaceSession().terminalPtyIncarnationsByPaneKey?.[paneKey]).toBe('inc-live')
    const reloaded = await createStore()
    expect(reloaded.getWorkspaceSession().terminalPtyIncarnationsByPaneKey?.[paneKey]).toBe(
      'inc-live'
    )
  })

  it('admits a split binding only while the exact source still owns its layout leaf', async () => {
    for (const hostId of [undefined, 'ssh:ssh-1']) {
      const store = await createStore()
      store.setWorkspaceSession(
        {
          ...getDefaultWorkspaceSession(),
          tabsByWorktree: {
            wt1: [makeTerminalTab({ id: 'tab1', worktreeId: 'wt1', ptyId: 'pty-source' })]
          },
          terminalLayoutsByTabId: {
            tab1: {
              root: { type: 'leaf', leafId: TEST_LEAF_1 },
              activeLeafId: TEST_LEAF_1,
              expandedLeafId: null,
              ptyIdsByLeafId: { [TEST_LEAF_1]: 'pty-source' }
            }
          }
        },
        hostId
      )
      const staleRendererSession = structuredClone(store.getWorkspaceSession(hostId))

      expect(
        store.persistPtyBinding(
          {
            worktreeId: 'wt1',
            tabId: 'different-target-tab',
            leafId: TEST_LEAF_2,
            ptyId: 'pty-split',
            expectedSourceBinding: {
              worktreeId: 'wt1',
              tabId: 'tab1',
              leafId: TEST_LEAF_1,
              ptyId: 'pty-source'
            }
          },
          hostId
        )
      ).toBe(false)
      expect(
        store
          .getWorkspaceSession(hostId)
          .tabsByWorktree.wt1.some((tab) => tab.id === 'different-target-tab')
      ).toBe(false)

      expect(
        store.persistPtyBinding(
          {
            worktreeId: 'wt-canonical',
            tabId: 'tab1',
            leafId: TEST_LEAF_2,
            ptyId: 'pty-split',
            expectedSourceBinding: {
              worktreeId: 'wt1',
              tabId: 'tab1',
              leafId: TEST_LEAF_1,
              ptyId: 'pty-source'
            }
          },
          hostId
        )
      ).toBe(true)
      const admitted = store.getWorkspaceSession(hostId)
      expect(admitted.terminalTopologyRevisionByRepoId?.wt1).toBe(1)
      expect(admitted.terminalLayoutsByTabId.tab1.ptyIdsByLeafId).toMatchObject({
        [TEST_LEAF_1]: 'pty-source',
        [TEST_LEAF_2]: 'pty-split'
      })

      store.setWorkspaceSession(staleRendererSession, hostId)
      expect(
        store.getWorkspaceSession(hostId).terminalLayoutsByTabId.tab1.ptyIdsByLeafId
      ).toMatchObject({
        [TEST_LEAF_1]: 'pty-source',
        [TEST_LEAF_2]: 'pty-split'
      })

      expect(
        store.persistPtyBinding(
          {
            worktreeId: 'wt1',
            tabId: 'rejected-tab',
            leafId: TEST_LEAF_2,
            ptyId: 'pty-rejected',
            expectedSourceBinding: {
              worktreeId: 'wt1',
              tabId: 'missing-source-tab',
              leafId: TEST_LEAF_1,
              ptyId: 'pty-source'
            }
          },
          hostId
        )
      ).toBe(false)
      expect(
        store
          .getWorkspaceSession(hostId)
          .tabsByWorktree.wt1.some((tab) => tab.id === 'rejected-tab')
      ).toBe(false)
      expect(
        store.getWorkspaceSession(hostId).terminalLayoutsByTabId['rejected-tab']
      ).toBeUndefined()
    }
  })
})
