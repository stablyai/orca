import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { testState, createStore, writeDataFile } from './persistence-test-harness'
import { getDefaultPersistedState } from '../shared/constants'
import { sshRemotePtyLeaseAllowsReattach } from '../shared/ssh-types'
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

/** One SSH pane bound to `ssh:ssh-1@@remote-pty` in both the tab row and the leaf map. */
async function storeWithBoundSshPane(): Promise<Awaited<ReturnType<typeof createStore>>> {
  const store = await createStore()
  store.upsertSshRemotePtyLease({
    targetId: 'ssh-1',
    ptyId: 'remote-pty',
    worktreeId: 'wt1',
    tabId: 'tab1',
    leafId: TEST_LEAF_1,
    state: 'attached'
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
          ptyId: 'ssh:ssh-1@@remote-pty'
        }
      ]
    },
    terminalLayoutsByTabId: {
      tab1: {
        root: { type: 'leaf', leafId: TEST_LEAF_1 },
        activeLeafId: TEST_LEAF_1,
        expandedLeafId: null,
        ptyIdsByLeafId: { [TEST_LEAF_1]: 'ssh:ssh-1@@remote-pty' }
      }
    }
  })
  return store
}

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
  it('merges missing prior layout bindings into partial renderer snapshots', async () => {
    const store = await createStore()
    store.upsertSshRemotePtyLease({
      targetId: 'ssh-1',
      ptyId: 'remote-pty-1',
      worktreeId: 'wt1',
      tabId: 'tab1',
      leafId: TEST_LEAF_1,
      state: 'detached'
    })
    store.upsertSshRemotePtyLease({
      targetId: 'ssh-1',
      ptyId: 'remote-pty-2',
      worktreeId: 'wt1',
      tabId: 'tab1',
      leafId: TEST_LEAF_2,
      state: 'detached'
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
            ptyId: 'remote-pty-1'
          }
        ]
      },
      terminalLayoutsByTabId: {
        tab1: {
          root: {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', leafId: TEST_LEAF_1 },
            second: { type: 'leaf', leafId: TEST_LEAF_2 },
            ratio: 0.5
          },
          activeLeafId: TEST_LEAF_2,
          expandedLeafId: null,
          ptyIdsByLeafId: {
            [TEST_LEAF_1]: 'remote-pty-1',
            [TEST_LEAF_2]: 'remote-pty-2'
          }
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
            ptyId: 'remote-pty-1'
          }
        ]
      },
      terminalLayoutsByTabId: {
        tab1: {
          root: {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', leafId: TEST_LEAF_1 },
            second: { type: 'leaf', leafId: TEST_LEAF_2 },
            ratio: 0.5
          },
          activeLeafId: TEST_LEAF_1,
          expandedLeafId: null,
          ptyIdsByLeafId: { [TEST_LEAF_1]: 'remote-pty-1' }
        }
      }
    })

    expect(store.getWorkspaceSession().terminalLayoutsByTabId.tab1.ptyIdsByLeafId).toEqual({
      [TEST_LEAF_1]: 'remote-pty-1',
      [TEST_LEAF_2]: 'remote-pty-2'
    })
  })

  // A partial renderer map is only repaired when a lease says the omitted sibling still belongs to
  // this host. `expired` says the client lost its route, not that the sibling died — repair it.
  // `terminated` is the operator-close state and must stay refused.
  it.each([
    ['expired', { [TEST_LEAF_1]: 'remote-pty-1', [TEST_LEAF_2]: 'remote-pty-2' }],
    ['terminated', { [TEST_LEAF_1]: 'remote-pty-1' }]
  ] as const)(
    'repairs a partial renderer snapshot for a %s sibling lease only when it is not terminated',
    async (siblingState, expected) => {
      const store = await createStore()
      store.upsertSshRemotePtyLease({
        targetId: 'ssh-1',
        ptyId: 'remote-pty-1',
        worktreeId: 'wt1',
        tabId: 'tab1',
        leafId: TEST_LEAF_1,
        state: 'detached'
      })
      store.upsertSshRemotePtyLease({
        targetId: 'ssh-1',
        ptyId: 'remote-pty-2',
        worktreeId: 'wt1',
        tabId: 'tab1',
        leafId: TEST_LEAF_2,
        state: siblingState
      })
      const layout = {
        root: {
          type: 'split' as const,
          direction: 'horizontal' as const,
          first: { type: 'leaf' as const, leafId: TEST_LEAF_1 },
          second: { type: 'leaf' as const, leafId: TEST_LEAF_2 },
          ratio: 0.5
        },
        activeLeafId: TEST_LEAF_1,
        expandedLeafId: null
      }
      const tabs = {
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
      }
      store.setWorkspaceSession({
        activeRepoId: 'r1',
        activeWorktreeId: 'wt1',
        activeTabId: 'tab1',
        tabsByWorktree: tabs,
        terminalLayoutsByTabId: {
          tab1: {
            ...layout,
            ptyIdsByLeafId: { [TEST_LEAF_1]: 'remote-pty-1', [TEST_LEAF_2]: 'remote-pty-2' }
          }
        }
      })

      // The renderer republishes only the leaf it still knows about.
      store.setWorkspaceSession({
        activeRepoId: 'r1',
        activeWorktreeId: 'wt1',
        activeTabId: 'tab1',
        tabsByWorktree: tabs,
        terminalLayoutsByTabId: {
          tab1: { ...layout, ptyIdsByLeafId: { [TEST_LEAF_1]: 'remote-pty-1' } }
        }
      })

      expect(store.getWorkspaceSession().terminalLayoutsByTabId.tab1.ptyIdsByLeafId).toEqual(
        expected
      )
    }
  )

  it('does not restore layout bindings for leaves removed from the incoming layout', async () => {
    const store = await createStore()
    store.upsertSshRemotePtyLease({
      targetId: 'ssh-1',
      ptyId: 'remote-pty-1',
      tabId: 'tab1',
      leafId: TEST_LEAF_1,
      state: 'detached'
    })
    store.upsertSshRemotePtyLease({
      targetId: 'ssh-1',
      ptyId: 'remote-pty-2',
      tabId: 'tab1',
      leafId: TEST_LEAF_2,
      state: 'detached'
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
            ptyId: 'remote-pty-1'
          }
        ]
      },
      terminalLayoutsByTabId: {
        tab1: {
          root: {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', leafId: TEST_LEAF_1 },
            second: { type: 'leaf', leafId: TEST_LEAF_2 },
            ratio: 0.5
          },
          activeLeafId: TEST_LEAF_2,
          expandedLeafId: null,
          ptyIdsByLeafId: {
            [TEST_LEAF_1]: 'remote-pty-1',
            [TEST_LEAF_2]: 'remote-pty-2'
          }
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
            ptyId: 'remote-pty-1'
          }
        ]
      },
      terminalLayoutsByTabId: {
        tab1: {
          root: { type: 'leaf', leafId: TEST_LEAF_1 },
          activeLeafId: TEST_LEAF_1,
          expandedLeafId: null,
          ptyIdsByLeafId: { [TEST_LEAF_1]: 'remote-pty-1' }
        }
      }
    })

    expect(store.getWorkspaceSession().terminalLayoutsByTabId.tab1.ptyIdsByLeafId).toEqual({
      [TEST_LEAF_1]: 'remote-pty-1'
    })
  })

  it('does not restore missing layout bindings without a live SSH lease', async () => {
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
            ptyId: 'local-pty-1'
          }
        ]
      },
      terminalLayoutsByTabId: {
        tab1: {
          root: {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', leafId: TEST_LEAF_1 },
            second: { type: 'leaf', leafId: TEST_LEAF_2 },
            ratio: 0.5
          },
          activeLeafId: TEST_LEAF_2,
          expandedLeafId: null,
          ptyIdsByLeafId: {
            [TEST_LEAF_1]: 'local-pty-1',
            [TEST_LEAF_2]: 'local-pty-2'
          }
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
            ptyId: 'local-pty-1'
          }
        ]
      },
      terminalLayoutsByTabId: {
        tab1: {
          root: {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', leafId: TEST_LEAF_1 },
            second: { type: 'leaf', leafId: TEST_LEAF_2 },
            ratio: 0.5
          },
          activeLeafId: TEST_LEAF_1,
          expandedLeafId: null,
          ptyIdsByLeafId: { [TEST_LEAF_1]: 'local-pty-1' }
        }
      }
    })

    expect(store.getWorkspaceSession().terminalLayoutsByTabId.tab1.ptyIdsByLeafId).toEqual({
      [TEST_LEAF_1]: 'local-pty-1'
    })
  })

  it('clears workspace bindings before removing SSH remote PTY leases for a target', async () => {
    const store = await createStore()
    store.upsertSshRemotePtyLease({
      targetId: 'ssh-1',
      ptyId: 'remote-pty',
      worktreeId: 'wt1',
      tabId: 'tab1',
      leafId: TEST_LEAF_1,
      state: 'detached'
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

    store.removeSshRemotePtyLeases('ssh-1')

    const session = store.getWorkspaceSession()
    expect(store.getSshRemotePtyLeases('ssh-1')).toEqual([])
    expect(session.tabsByWorktree.wt1[0].ptyId).toBeNull()
    expect(session.terminalLayoutsByTabId.tab1.ptyIdsByLeafId).toEqual({})
  })

  it('clears workspace bindings when marking all SSH remote PTY leases for a target terminated', async () => {
    const store = await createStore()
    store.upsertSshRemotePtyLease({
      targetId: 'ssh-1',
      ptyId: 'remote-pty',
      worktreeId: 'wt1',
      tabId: 'tab1',
      leafId: TEST_LEAF_1,
      state: 'attached'
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
            ptyId: 'ssh:ssh-1@@remote-pty'
          }
        ]
      },
      terminalLayoutsByTabId: {
        tab1: {
          root: { type: 'leaf', leafId: TEST_LEAF_1 },
          activeLeafId: TEST_LEAF_1,
          expandedLeafId: null,
          ptyIdsByLeafId: { [TEST_LEAF_1]: 'ssh:ssh-1@@remote-pty' }
        }
      }
    })

    store.markSshRemotePtyLeases('ssh-1', 'terminated')

    const session = store.getWorkspaceSession()
    expect(store.getSshRemotePtyLeases('ssh-1')).toEqual([
      expect.objectContaining({
        ptyId: 'remote-pty',
        state: 'terminated'
      })
    ])
    expect(session.tabsByWorktree.wt1[0].ptyId).toBeNull()
    expect(session.terminalLayoutsByTabId.tab1.ptyIdsByLeafId).toEqual({})
  })

  it('matches scoped SSH workspace bindings against raw relay leases', async () => {
    const store = await createStore()
    store.upsertSshRemotePtyLease({
      targetId: 'ssh-1',
      ptyId: 'remote-pty',
      worktreeId: 'wt1',
      tabId: 'tab1',
      leafId: TEST_LEAF_1,
      state: 'detached'
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
            ptyId: 'ssh:ssh-1@@remote-pty'
          }
        ]
      },
      terminalLayoutsByTabId: {
        tab1: {
          root: { type: 'leaf', leafId: TEST_LEAF_1 },
          activeLeafId: TEST_LEAF_1,
          expandedLeafId: null,
          ptyIdsByLeafId: { [TEST_LEAF_1]: 'ssh:ssh-1@@remote-pty' }
        }
      }
    })

    store.removeSshRemotePtyLeases('ssh-1')

    const session = store.getWorkspaceSession()
    expect(store.getSshRemotePtyLeases('ssh-1')).toEqual([])
    expect(session.tabsByWorktree.wt1[0].ptyId).toBeNull()
    expect(session.terminalLayoutsByTabId.tab1.ptyIdsByLeafId).toEqual({})
  })

  it('stores scoped SSH remote PTY leases as raw relay ids', async () => {
    const store = await createStore()

    store.upsertSshRemotePtyLease({
      targetId: 'ssh-1',
      ptyId: 'ssh:ssh-1@@remote-pty',
      state: 'attached'
    })

    expect(store.getSshRemotePtyLeases('ssh-1')).toEqual([
      expect.objectContaining({
        targetId: 'ssh-1',
        ptyId: 'remote-pty',
        state: 'attached'
      })
    ])
  })

  it('rejects mismatched scoped SSH remote PTY lease ids on write paths', async () => {
    const store = await createStore()

    expect(() =>
      store.upsertSshRemotePtyLease({
        targetId: 'ssh-1',
        ptyId: 'ssh:ssh-2@@remote-pty',
        state: 'attached'
      })
    ).toThrow('belongs to SSH connection "ssh-2"')
  })

  it('updates SSH remote PTY leases when callers pass scoped app ids', async () => {
    const store = await createStore()
    store.upsertSshRemotePtyLease({
      targetId: 'ssh-1',
      ptyId: 'remote-pty',
      state: 'attached'
    })

    store.markSshRemotePtyLease('ssh-1', 'ssh:ssh-1@@remote-pty', 'terminated')

    expect(store.getSshRemotePtyLeases('ssh-1')).toEqual([
      expect.objectContaining({
        ptyId: 'remote-pty',
        state: 'terminated'
      })
    ])
  })

  // `expired` never means the shell exited — every writer records that the CLIENT lost its route
  // (superseded sibling, recycled relay id, persistPtyBinding refusal, failed reattach, relay
  // reset). Wiping the binding here made adoptStablePane return null and forced createTerminal
  // into a fresh spawn, stranding a remote process that is still running.
  it('keeps workspace bindings when marking an SSH remote PTY lease expired', async () => {
    const store = await storeWithBoundSshPane()

    store.markSshRemotePtyLease('ssh-1', 'ssh:ssh-1@@remote-pty', 'expired')

    const session = store.getWorkspaceSession()
    expect(store.getSshRemotePtyLeases('ssh-1')).toEqual([
      expect.objectContaining({
        ptyId: 'remote-pty',
        state: 'expired'
      })
    ])
    expect(session.tabsByWorktree.wt1[0].ptyId).toBe('ssh:ssh-1@@remote-pty')
    expect(session.terminalLayoutsByTabId.tab1.ptyIdsByLeafId).toEqual({
      [TEST_LEAF_1]: 'ssh:ssh-1@@remote-pty'
    })
  })

  it('clears workspace bindings when marking an SSH remote PTY lease terminated', async () => {
    const store = await storeWithBoundSshPane()

    store.markSshRemotePtyLease('ssh-1', 'ssh:ssh-1@@remote-pty', 'terminated')

    const session = store.getWorkspaceSession()
    expect(store.getSshRemotePtyLeases('ssh-1')).toEqual([
      expect.objectContaining({
        ptyId: 'remote-pty',
        state: 'terminated'
      })
    ])
    expect(session.tabsByWorktree.wt1[0].ptyId).toBeNull()
    expect(session.terminalLayoutsByTabId.tab1.ptyIdsByLeafId).toEqual({})
  })

  // The bulk writer takes the same decision; only the operator-close state may unbind a pane.
  it('keeps workspace bindings for a bulk expire and clears them for a bulk terminate', async () => {
    const expiredStore = await storeWithBoundSshPane()
    expiredStore.markSshRemotePtyLeases('ssh-1', 'expired')
    expect(expiredStore.getWorkspaceSession().terminalLayoutsByTabId.tab1.ptyIdsByLeafId).toEqual({
      [TEST_LEAF_1]: 'ssh:ssh-1@@remote-pty'
    })

    const terminatedStore = await storeWithBoundSshPane()
    terminatedStore.markSshRemotePtyLeases('ssh-1', 'terminated')
    expect(
      terminatedStore.getWorkspaceSession().terminalLayoutsByTabId.tab1.ptyIdsByLeafId
    ).toEqual({})
  })

  it('removes SSH remote PTY leases when callers pass scoped app ids', async () => {
    const store = await createStore()
    store.upsertSshRemotePtyLease({
      targetId: 'ssh-1',
      ptyId: 'remote-pty',
      worktreeId: 'wt1',
      tabId: 'tab1',
      leafId: TEST_LEAF_1,
      state: 'detached'
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
            ptyId: 'ssh:ssh-1@@remote-pty'
          }
        ]
      },
      terminalLayoutsByTabId: {
        tab1: {
          root: { type: 'leaf', leafId: TEST_LEAF_1 },
          activeLeafId: TEST_LEAF_1,
          expandedLeafId: null,
          ptyIdsByLeafId: { [TEST_LEAF_1]: 'ssh:ssh-1@@remote-pty' }
        }
      }
    })

    store.removeSshRemotePtyLease('ssh-1', 'ssh:ssh-1@@remote-pty')

    const session = store.getWorkspaceSession()
    expect(store.getSshRemotePtyLeases('ssh-1')).toEqual([])
    expect(session.tabsByWorktree.wt1[0].ptyId).toBeNull()
    expect(session.terminalLayoutsByTabId.tab1.ptyIdsByLeafId).toEqual({})
  })

  it('clears workspace bindings before removing contextless SSH remote PTY leases', async () => {
    const store = await createStore()
    store.upsertSshRemotePtyLease({
      targetId: 'ssh-1',
      ptyId: 'remote-pty',
      state: 'detached'
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

    store.removeSshRemotePtyLeases('ssh-1')

    const session = store.getWorkspaceSession()
    expect(store.getSshRemotePtyLeases('ssh-1')).toEqual([])
    expect(session.tabsByWorktree.wt1[0].ptyId).toBeNull()
    expect(session.terminalLayoutsByTabId.tab1.ptyIdsByLeafId).toEqual({})
  })

  it('does not revive expired leases when marking a target detached', async () => {
    const store = await createStore()
    store.upsertSshRemotePtyLease({
      targetId: 'ssh-1',
      ptyId: 'live-pty',
      state: 'attached'
    })
    store.upsertSshRemotePtyLease({
      targetId: 'ssh-1',
      ptyId: 'expired-pty',
      state: 'expired'
    })

    store.markSshRemotePtyLeases('ssh-1', 'detached')

    expect(store.getSshRemotePtyLeases('ssh-1')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ptyId: 'live-pty', state: 'detached' }),
        expect.objectContaining({ ptyId: 'expired-pty', state: 'expired' })
      ])
    )
  })
})

/**
 * The lease loader is a strict whitelist, so a field it does not name is stripped on every launch
 * and the mark that keeps a superseded predecessor out of the reattach set would silently stop
 * working. Both skew directions are Rule 1 of docs/reference/remote-wire-compatibility.md: this
 * build reads a row an older one wrote, and an older build ignores the keys it never heard of.
 */
describe('ssh remote pty lease route-retirement marks survive the disk round trip', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
  })
  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  function persistLeases(leases: unknown[]): void {
    const persisted = getDefaultPersistedState(testState.dir)
    writeDataFile({ ...persisted, sshRemotePtyLeases: leases })
  }

  it('salvages both marks rather than stripping them', async () => {
    persistLeases([
      {
        targetId: 'ssh-1',
        ptyId: 'pty-1',
        state: 'expired',
        createdAt: 1,
        updatedAt: 2,
        supersededBy: 'pty-2'
      },
      {
        targetId: 'ssh-1',
        ptyId: 'pty-3',
        state: 'expired',
        createdAt: 1,
        updatedAt: 2,
        relayIdRecycled: true
      }
    ])

    const store = await createStore()

    expect(store.getSshRemotePtyLeases('ssh-1')).toEqual([
      expect.objectContaining({ ptyId: 'pty-1', supersededBy: 'pty-2' }),
      expect.objectContaining({ ptyId: 'pty-3', relayIdRecycled: true })
    ])
    expect(store.getSshRemotePtyLeases('ssh-1').filter(sshRemotePtyLeaseAllowsReattach)).toEqual([])
  })

  // A row an older build wrote carries neither mark. Absence must read as "orphan", which is the
  // reattachable answer — the older build had no way to say otherwise.
  it('reads a row written before the marks existed as a reattachable orphan', async () => {
    persistLeases([
      { targetId: 'ssh-1', ptyId: 'pty-1', state: 'expired', createdAt: 1, updatedAt: 2 }
    ])

    const store = await createStore()
    const [lease] = store.getSshRemotePtyLeases('ssh-1')

    expect(lease).toMatchObject({ ptyId: 'pty-1', state: 'expired' })
    expect(lease.supersededBy).toBeUndefined()
    expect(lease.relayIdRecycled).toBeUndefined()
    expect(sshRemotePtyLeaseAllowsReattach(lease)).toBe(true)
  })

  it('drops a mistyped mark instead of trusting it', async () => {
    persistLeases([
      {
        targetId: 'ssh-1',
        ptyId: 'pty-1',
        state: 'expired',
        createdAt: 1,
        updatedAt: 2,
        supersededBy: 7,
        relayIdRecycled: 'yes'
      }
    ])

    const store = await createStore()
    const [lease] = store.getSshRemotePtyLeases('ssh-1')

    expect(lease.supersededBy).toBeUndefined()
    expect(lease.relayIdRecycled).toBeUndefined()
  })
})
