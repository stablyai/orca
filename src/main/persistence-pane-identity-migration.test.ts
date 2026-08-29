import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { writeFileSync, rmSync, mkdtempSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { PersistedState } from '../shared/persisted-state-types'
import { isTerminalLeafId, makePaneKey } from '../shared/stable-pane-id'
import { testState, createStore, writeDataFile, readDataFile } from './persistence-test-harness'
import {
  TEST_LEAF_1,
  TEST_LEAF_2,
  makeBalancedLegacyPaneLayout
} from './persistence-session-fixtures'

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
  it('hydrates split-pane legacy numeric agent status rows onto the matching remapped leaves', async () => {
    const agentHooksDir = join(testState.dir, 'agent-hooks')
    mkdirSync(agentHooksDir, { recursive: true })
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
              ptyId: 'local-pty-1'
            }
          ]
        },
        terminalLayoutsByTabId: {
          tab1: {
            root: {
              type: 'split',
              direction: 'horizontal',
              first: { type: 'leaf', leafId: 'pane:1' },
              second: { type: 'leaf', leafId: 'pane:2' },
              sizes: [50, 50]
            },
            activeLeafId: 'pane:1',
            expandedLeafId: null,
            ptyIdsByLeafId: { 'pane:1': 'local-pty-1', 'pane:2': 'local-pty-2' }
          }
        }
      }
    })
    const now = Date.now()
    writeFileSync(
      join(agentHooksDir, 'last-status.json'),
      JSON.stringify({
        version: 2,
        entries: {
          'tab1:1': {
            paneKey: 'tab1:1',
            tabId: 'tab1',
            worktreeId: 'wt1',
            connectionId: null,
            receivedAt: now,
            stateStartedAt: now - 2000,
            payload: { state: 'working', prompt: 'left legacy prompt', agentType: 'claude' }
          },
          'tab1:2': {
            paneKey: 'tab1:2',
            tabId: 'tab1',
            worktreeId: 'wt1',
            connectionId: null,
            receivedAt: now,
            stateStartedAt: now - 1000,
            payload: { state: 'blocked', prompt: 'right legacy prompt', agentType: 'codex' }
          }
        }
      }),
      'utf-8'
    )

    const store = await createStore()
    const { agentHookServer } = await import('./agent-hooks/server')
    await agentHookServer.start({ env: 'production', userDataPath: testState.dir })
    try {
      const layout = store.getWorkspaceSession().terminalLayoutsByTabId.tab1
      const firstLeafId =
        layout.root?.type === 'split' && layout.root.first.type === 'leaf'
          ? layout.root.first.leafId
          : null
      const secondLeafId =
        layout.root?.type === 'split' && layout.root.second.type === 'leaf'
          ? layout.root.second.leafId
          : null
      if (firstLeafId === null || secondLeafId === null) {
        throw new Error('Expected remapped split leaves')
      }
      const byPaneKey = new Map(
        agentHookServer.getStatusSnapshot().map((entry) => [entry.paneKey, entry])
      )

      expect(byPaneKey.get(makePaneKey('tab1', firstLeafId))).toEqual(
        expect.objectContaining({
          state: 'working',
          prompt: 'left legacy prompt',
          agentType: 'claude'
        })
      )
      expect(byPaneKey.get(makePaneKey('tab1', secondLeafId))).toEqual(
        expect.objectContaining({
          state: 'blocked',
          prompt: 'right legacy prompt',
          agentType: 'codex'
        })
      )
    } finally {
      agentHookServer.stop()
    }
  })

  it('hydrates split-pane legacy status rows even when PTY leaf bindings are absent', async () => {
    const agentHooksDir = join(testState.dir, 'agent-hooks')
    mkdirSync(agentHooksDir, { recursive: true })
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
              ptyId: 'local-pty-1'
            }
          ]
        },
        terminalLayoutsByTabId: {
          tab1: {
            root: {
              type: 'split',
              direction: 'vertical',
              first: { type: 'leaf', leafId: 'pane:1' },
              second: { type: 'leaf', leafId: 'pane:2' },
              sizes: [50, 50]
            },
            activeLeafId: 'pane:2',
            expandedLeafId: null
          }
        }
      }
    })
    const now = Date.now()
    writeFileSync(
      join(agentHooksDir, 'last-status.json'),
      JSON.stringify({
        version: 2,
        entries: {
          'tab1:1': {
            paneKey: 'tab1:1',
            tabId: 'tab1',
            worktreeId: 'wt1',
            connectionId: null,
            receivedAt: now,
            stateStartedAt: now - 2000,
            payload: { state: 'working', prompt: 'left no binding', agentType: 'claude' }
          },
          'tab1:2': {
            paneKey: 'tab1:2',
            tabId: 'tab1',
            worktreeId: 'wt1',
            connectionId: null,
            receivedAt: now,
            stateStartedAt: now - 1000,
            payload: { state: 'blocked', prompt: 'right no binding', agentType: 'codex' }
          }
        }
      }),
      'utf-8'
    )

    const store = await createStore()
    const { agentHookServer } = await import('./agent-hooks/server')
    await agentHookServer.start({ env: 'production', userDataPath: testState.dir })
    try {
      const layout = store.getWorkspaceSession().terminalLayoutsByTabId.tab1
      const firstLeafId =
        layout.root?.type === 'split' && layout.root.first.type === 'leaf'
          ? layout.root.first.leafId
          : null
      const secondLeafId =
        layout.root?.type === 'split' && layout.root.second.type === 'leaf'
          ? layout.root.second.leafId
          : null
      if (firstLeafId === null || secondLeafId === null) {
        throw new Error('Expected remapped split leaves')
      }
      const byPaneKey = new Map(
        agentHookServer.getStatusSnapshot().map((entry) => [entry.paneKey, entry])
      )

      expect(byPaneKey.get(makePaneKey('tab1', firstLeafId))).toEqual(
        expect.objectContaining({
          state: 'working',
          prompt: 'left no binding',
          agentType: 'claude'
        })
      )
      expect(byPaneKey.get(makePaneKey('tab1', secondLeafId))).toEqual(
        expect.objectContaining({
          state: 'blocked',
          prompt: 'right no binding',
          agentType: 'codex'
        })
      )
    } finally {
      agentHookServer.stop()
    }
  })

  it('persists legacy pane-key aliases after the layout has been normalized', async () => {
    const agentHooksDir = join(testState.dir, 'agent-hooks')
    mkdirSync(agentHooksDir, { recursive: true })
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
              ptyId: 'local-pty'
            }
          ]
        },
        terminalLayoutsByTabId: {
          tab1: {
            root: { type: 'leaf', leafId: 'pane:1' },
            activeLeafId: 'pane:1',
            expandedLeafId: null,
            ptyIdsByLeafId: { 'pane:1': 'local-pty' }
          }
        }
      }
    })

    const firstStore = await createStore()
    const root = firstStore.getWorkspaceSession().terminalLayoutsByTabId.tab1.root
    const stableLeafId = root?.type === 'leaf' ? root.leafId : null
    if (stableLeafId === null) {
      throw new Error('Expected remapped leaf id')
    }
    const stablePaneKey = makePaneKey('tab1', stableLeafId)
    firstStore.flush()

    expect(readDataFile()).toEqual(
      expect.objectContaining({
        legacyPaneKeyAliasEntries: [
          expect.objectContaining({
            ptyId: 'local-pty',
            legacyPaneKey: 'tab1:1',
            stablePaneKey
          })
        ]
      })
    )

    const now = Date.now()
    writeFileSync(
      join(agentHooksDir, 'last-status.json'),
      JSON.stringify({
        version: 2,
        entries: {
          'tab1:1': {
            paneKey: 'tab1:1',
            tabId: 'tab1',
            worktreeId: 'wt1',
            connectionId: null,
            receivedAt: now,
            stateStartedAt: now - 1000,
            payload: { state: 'working', prompt: 'post-normalize legacy prompt' }
          }
        }
      }),
      'utf-8'
    )

    await createStore()
    const { agentHookServer } = await import('./agent-hooks/server')
    await agentHookServer.start({ env: 'production', userDataPath: testState.dir })
    try {
      expect(agentHookServer.getStatusSnapshot()).toEqual([
        expect.objectContaining({
          paneKey: stablePaneKey,
          state: 'working',
          prompt: 'post-normalize legacy prompt'
        })
      ])
    } finally {
      agentHookServer.stop()
    }
  })

  it('restores cross-tab pane authority aliases before hook ingestion', async () => {
    const physicalPaneKey = makePaneKey('tab-source', TEST_LEAF_1)
    const ownerPaneKey = makePaneKey('tab-target', TEST_LEAF_2)
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {},
      ui: {},
      githubCache: { pr: {}, issue: {} },
      legacyPaneKeyAliasEntries: [
        {
          ptyId: 'pty-detached',
          legacyPaneKey: physicalPaneKey,
          stablePaneKey: ownerPaneKey,
          updatedAt: 10
        }
      ]
    })

    await createStore()
    const { agentHookServer } = await import('./agent-hooks/server')
    agentHookServer.ingestTerminalStatus({
      paneKey: physicalPaneKey,
      tabId: 'tab-source',
      worktreeId: 'wt1',
      payload: { state: 'working', prompt: 'detached after restart' }
    })

    expect(agentHookServer.getStatusSnapshot()).toEqual([
      expect.objectContaining({
        paneKey: ownerPaneKey,
        tabId: 'tab-target',
        prompt: 'detached after restart'
      })
    ])
  })

  it('persists fallback aliases when a legacy split layout has no PTY leaf bindings', async () => {
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
              ptyId: 'local-pty'
            }
          ]
        },
        terminalLayoutsByTabId: {
          tab1: {
            root: {
              type: 'split',
              direction: 'vertical',
              first: { type: 'leaf', leafId: 'pane:1' },
              second: { type: 'leaf', leafId: 'pane:2' },
              sizes: [50, 50]
            },
            activeLeafId: 'pane:2',
            expandedLeafId: null
          }
        }
      }
    })

    const store = await createStore()
    const layout = store.getWorkspaceSession().terminalLayoutsByTabId.tab1
    const firstLeafId =
      layout.root?.type === 'split' && layout.root.first.type === 'leaf'
        ? layout.root.first.leafId
        : null
    const secondLeafId =
      layout.root?.type === 'split' && layout.root.second.type === 'leaf'
        ? layout.root.second.leafId
        : null
    if (
      !firstLeafId ||
      !secondLeafId ||
      !isTerminalLeafId(firstLeafId) ||
      !isTerminalLeafId(secondLeafId)
    ) {
      throw new Error('Expected remapped split leaf ids')
    }
    const activePaneKey = makePaneKey('tab1', secondLeafId)
    const firstPaneKey = makePaneKey('tab1', firstLeafId)
    const secondPaneKey = makePaneKey('tab1', secondLeafId)
    store.flush()

    expect(readDataFile()).toEqual(
      expect.objectContaining({
        legacyPaneKeyAliasEntries: expect.arrayContaining([
          expect.objectContaining({
            ptyId: 'local-pty',
            legacyPaneKey: 'tab1:0',
            stablePaneKey: activePaneKey
          }),
          expect.objectContaining({
            ptyId: 'local-pty',
            legacyPaneKey: 'tab1:1',
            stablePaneKey: firstPaneKey
          }),
          expect.objectContaining({
            ptyId: 'local-pty',
            legacyPaneKey: 'tab1:2',
            stablePaneKey: secondPaneKey
          })
        ])
      })
    )
  })

  it('loads legacy pane aliases from very large persisted split layouts', async () => {
    const leafCount = 130_000
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
              ptyId: 'large-pty'
            }
          ]
        },
        terminalLayoutsByTabId: {
          tab1: {
            root: makeBalancedLegacyPaneLayout(0, leafCount),
            activeLeafId: 'pane:1',
            expandedLeafId: null
          }
        }
      }
    })

    const store = await createStore()
    store.flush()

    const persisted = readDataFile() as PersistedState
    const aliasEntries = persisted.legacyPaneKeyAliasEntries
    expect(aliasEntries).toHaveLength(leafCount + 1)
    expect(
      aliasEntries.some((entry) => entry.ptyId === 'large-pty' && entry.legacyPaneKey === 'tab1:0')
    ).toBe(true)
    expect(
      aliasEntries.some((entry) => entry.ptyId === 'large-pty' && entry.legacyPaneKey === 'tab1:1')
    ).toBe(true)
    expect(
      aliasEntries.some(
        (entry) => entry.ptyId === 'large-pty' && entry.legacyPaneKey === `tab1:${leafCount}`
      )
    ).toBe(true)
  })

  it('converts unambiguous dev migration rows into persisted aliases', async () => {
    const stablePaneKey = makePaneKey('tab1', TEST_LEAF_1)
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
              ptyId: 'local-pty'
            }
          ]
        },
        terminalLayoutsByTabId: {
          tab1: {
            root: { type: 'leaf', leafId: TEST_LEAF_1 },
            activeLeafId: TEST_LEAF_1,
            expandedLeafId: null,
            ptyIdsByLeafId: { [TEST_LEAF_1]: 'local-pty' }
          }
        }
      },
      migrationUnsupportedPtyEntries: [
        {
          ptyId: 'local-pty',
          worktreeId: 'wt1',
          tabId: 'tab1',
          leafId: TEST_LEAF_1,
          paneKey: stablePaneKey,
          reason: 'legacy-numeric-pane-key',
          source: 'local',
          updatedAt: 123
        }
      ]
    })

    const store = await createStore()
    store.flush()

    expect(readDataFile()).toEqual(
      expect.objectContaining({
        migrationUnsupportedPtyEntries: [],
        legacyPaneKeyAliasEntries: expect.arrayContaining([
          expect.objectContaining({
            ptyId: 'local-pty',
            legacyPaneKey: 'tab1:0',
            stablePaneKey
          }),
          expect.objectContaining({
            ptyId: 'local-pty',
            legacyPaneKey: 'tab1:1',
            stablePaneKey
          })
        ])
      })
    )
  })
})
