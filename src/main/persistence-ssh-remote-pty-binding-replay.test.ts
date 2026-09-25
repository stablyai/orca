import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { testState, createStore } from './persistence-test-harness'
import { TEST_LEAF_1, TEST_LEAF_2 } from './persistence-session-fixtures'
import type { WorkspaceSessionState } from '../shared/workspace-session-state-types'

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
  it('retains an SSH host binding when a stale renderer clears its pty map', async () => {
    const store = await createStore()
    const hostId = 'ssh:ssh-1'
    const session = {
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
            ptyId: 'ssh:ssh-1@@old'
          }
        ]
      },
      terminalLayoutsByTabId: {
        tab1: {
          root: { type: 'leaf' as const, leafId: TEST_LEAF_1 },
          activeLeafId: TEST_LEAF_1,
          expandedLeafId: null,
          ptyIdsByLeafId: { [TEST_LEAF_1]: 'ssh:ssh-1@@old' }
        }
      }
    }
    store.setWorkspaceSession(session, hostId)
    store.upsertSshRemotePtyLease({
      targetId: 'ssh-1',
      ptyId: 'old',
      worktreeId: 'wt1',
      tabId: 'tab1',
      leafId: TEST_LEAF_1,
      state: 'detached'
    })
    store.setWorkspaceSession(
      {
        ...session,
        tabsByWorktree: {
          wt1: [{ ...session.tabsByWorktree.wt1[0], ptyId: null }]
        },
        terminalLayoutsByTabId: {
          tab1: {
            ...session.terminalLayoutsByTabId.tab1,
            ptyIdsByLeafId: {}
          }
        }
      },
      hostId
    )
    expect(store.getWorkspaceSession(hostId).terminalLayoutsByTabId.tab1.ptyIdsByLeafId).toEqual({
      [TEST_LEAF_1]: 'ssh:ssh-1@@old'
    })
  })

  it('does not replay a scoped SSH binding from a different host partition', async () => {
    const store = await createStore()
    const hostId = 'ssh:ssh-1'
    const session: WorkspaceSessionState = {
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
            ptyId: 'ssh:ssh-2@@foreign'
          }
        ]
      },
      terminalLayoutsByTabId: {
        tab1: {
          root: { type: 'leaf', leafId: TEST_LEAF_1 },
          activeLeafId: TEST_LEAF_1,
          expandedLeafId: null,
          ptyIdsByLeafId: { [TEST_LEAF_1]: 'ssh:ssh-2@@foreign' }
        }
      }
    }
    store.setWorkspaceSession(session, hostId)
    store.setWorkspaceSession(
      {
        ...session,
        tabsByWorktree: {
          wt1: [{ ...session.tabsByWorktree.wt1[0]!, ptyId: null }]
        },
        terminalLayoutsByTabId: {
          tab1: { ...session.terminalLayoutsByTabId.tab1!, ptyIdsByLeafId: {} }
        }
      },
      hostId
    )

    const persisted = store.getWorkspaceSession(hostId)
    expect(persisted.tabsByWorktree.wt1[0]!.ptyId).toBeNull()
    expect(persisted.terminalLayoutsByTabId.tab1.ptyIdsByLeafId).toEqual({})
  })

  it('retains a runtime host binding when no death evidence exists', async () => {
    const store = await createStore()
    const hostId = 'runtime:env-1'
    const session: WorkspaceSessionState = {
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
            ptyId: 'runtime-pty'
          }
        ]
      },
      terminalLayoutsByTabId: {
        tab1: {
          root: { type: 'leaf', leafId: TEST_LEAF_1 },
          activeLeafId: TEST_LEAF_1,
          expandedLeafId: null,
          ptyIdsByLeafId: { [TEST_LEAF_1]: 'runtime-pty' }
        }
      }
    }
    store.setWorkspaceSession(session, hostId)
    store.setWorkspaceSession(
      {
        ...session,
        tabsByWorktree: {
          wt1: [{ ...session.tabsByWorktree.wt1[0]!, ptyId: null }]
        },
        terminalLayoutsByTabId: {
          tab1: { ...session.terminalLayoutsByTabId.tab1!, ptyIdsByLeafId: {} }
        }
      },
      hostId
    )
    expect(store.getWorkspaceSession(hostId).terminalLayoutsByTabId.tab1.ptyIdsByLeafId).toEqual({
      [TEST_LEAF_1]: 'runtime-pty'
    })
  })

  // `expired` is the client admitting it lost its route; the remote shell may still be running,
  // so the pane keeps the binding it needs to reattach.
  it('restores a host binding after its SSH lease expires', async () => {
    const store = await createStore()
    const hostId = 'ssh:ssh-1'
    const session: WorkspaceSessionState = {
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
            ptyId: 'ssh:ssh-1@@expired'
          }
        ]
      },
      terminalLayoutsByTabId: {
        tab1: {
          root: { type: 'leaf', leafId: TEST_LEAF_1 },
          activeLeafId: TEST_LEAF_1,
          expandedLeafId: null,
          ptyIdsByLeafId: { [TEST_LEAF_1]: 'ssh:ssh-1@@expired' }
        }
      }
    }
    store.setWorkspaceSession(session, hostId)
    store.upsertSshRemotePtyLease({
      targetId: 'ssh-1',
      ptyId: 'expired',
      worktreeId: 'wt1',
      tabId: 'tab1',
      leafId: TEST_LEAF_1,
      state: 'expired'
    })
    store.setWorkspaceSession(
      {
        ...session,
        tabsByWorktree: {
          wt1: [{ ...session.tabsByWorktree.wt1[0]!, ptyId: null }]
        },
        terminalLayoutsByTabId: {
          tab1: { ...session.terminalLayoutsByTabId.tab1!, ptyIdsByLeafId: {} }
        }
      },
      hostId
    )
    const persisted = store.getWorkspaceSession(hostId)
    expect(persisted.tabsByWorktree.wt1[0]!.ptyId).toBe('ssh:ssh-1@@expired')
    expect(persisted.terminalLayoutsByTabId.tab1.ptyIdsByLeafId).toEqual({
      [TEST_LEAF_1]: 'ssh:ssh-1@@expired'
    })
  })

  it('does not resurrect a host binding after its SSH lease was terminated', async () => {
    const store = await createStore()
    const hostId = 'ssh:ssh-1'
    const session: WorkspaceSessionState = {
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
            ptyId: 'ssh:ssh-1@@expired'
          }
        ]
      },
      terminalLayoutsByTabId: {
        tab1: {
          root: { type: 'leaf', leafId: TEST_LEAF_1 },
          activeLeafId: TEST_LEAF_1,
          expandedLeafId: null,
          ptyIdsByLeafId: { [TEST_LEAF_1]: 'ssh:ssh-1@@expired' }
        }
      }
    }
    store.setWorkspaceSession(session, hostId)
    store.upsertSshRemotePtyLease({
      targetId: 'ssh-1',
      ptyId: 'expired',
      worktreeId: 'wt1',
      tabId: 'tab1',
      leafId: TEST_LEAF_1,
      state: 'terminated'
    })
    store.setWorkspaceSession(
      {
        ...session,
        tabsByWorktree: {
          wt1: [{ ...session.tabsByWorktree.wt1[0]!, ptyId: null }]
        },
        terminalLayoutsByTabId: {
          tab1: { ...session.terminalLayoutsByTabId.tab1!, ptyIdsByLeafId: {} }
        }
      },
      hostId
    )
    const persisted = store.getWorkspaceSession(hostId)
    expect(persisted.tabsByWorktree.wt1[0]!.ptyId).toBeNull()
    expect(persisted.terminalLayoutsByTabId.tab1.ptyIdsByLeafId).toEqual({})
  })

  it('retains surviving leaves while ignoring bindings for removed leaves', async () => {
    const store = await createStore()
    const hostId = 'runtime:env-1'
    const session: WorkspaceSessionState = {
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
            ptyId: 'runtime-pty-1'
          }
        ]
      },
      terminalLayoutsByTabId: {
        tab1: {
          root: {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', leafId: TEST_LEAF_1 },
            second: { type: 'leaf', leafId: TEST_LEAF_2 }
          },
          activeLeafId: TEST_LEAF_1,
          expandedLeafId: null,
          ptyIdsByLeafId: {
            [TEST_LEAF_1]: 'runtime-pty-1',
            [TEST_LEAF_2]: 'runtime-pty-2'
          }
        }
      }
    }
    store.setWorkspaceSession(session, hostId)
    store.setWorkspaceSession(
      {
        ...session,
        tabsByWorktree: {
          wt1: [{ ...session.tabsByWorktree.wt1[0]!, ptyId: null }]
        },
        terminalLayoutsByTabId: {
          tab1: {
            ...session.terminalLayoutsByTabId.tab1!,
            root: { type: 'leaf', leafId: TEST_LEAF_2 },
            activeLeafId: TEST_LEAF_2,
            ptyIdsByLeafId: {}
          }
        }
      },
      hostId
    )
    const persisted = store.getWorkspaceSession(hostId)
    expect(persisted.tabsByWorktree.wt1[0]!.ptyId).toBeNull()
    expect(persisted.terminalLayoutsByTabId.tab1.ptyIdsByLeafId).toEqual({
      [TEST_LEAF_2]: 'runtime-pty-2'
    })
  })

  it('does not restore a binding with an explicit SSH termination tombstone', async () => {
    const store = await createStore()
    const hostId = 'ssh:ssh-1'
    const session: WorkspaceSessionState = {
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
            ptyId: 'ssh:ssh-1@@closed'
          }
        ]
      },
      terminalLayoutsByTabId: {
        tab1: {
          root: { type: 'leaf', leafId: TEST_LEAF_1 },
          activeLeafId: TEST_LEAF_1,
          expandedLeafId: null,
          ptyIdsByLeafId: { [TEST_LEAF_1]: 'ssh:ssh-1@@closed' }
        }
      }
    }
    store.setWorkspaceSession(session, hostId)
    store.upsertSshRemotePtyLease({
      targetId: 'ssh-1',
      ptyId: 'closed',
      worktreeId: 'wt1',
      tabId: 'tab1',
      leafId: TEST_LEAF_1,
      state: 'terminated'
    })
    store.setWorkspaceSession(
      {
        ...session,
        tabsByWorktree: {
          wt1: [{ ...session.tabsByWorktree.wt1[0]!, ptyId: null }]
        },
        terminalLayoutsByTabId: {
          tab1: { ...session.terminalLayoutsByTabId.tab1!, ptyIdsByLeafId: {} }
        }
      },
      hostId
    )

    const persisted = store.getWorkspaceSession(hostId)
    expect(persisted.tabsByWorktree.wt1[0]!.ptyId).toBeNull()
    expect(persisted.terminalLayoutsByTabId.tab1.ptyIdsByLeafId).toEqual({})
  })
})
