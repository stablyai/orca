import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { WorkspaceSessionState } from '../shared/workspace-session-state-types'
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
  it('rejects a split source incarnation mismatch', async () => {
    const store = await createStore()
    store.setWorkspaceSession({
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
      },
      terminalPtyIncarnationsByPaneKey: { [`tab1:${TEST_LEAF_1}`]: 'persisted-incarnation' }
    })

    expect(
      store.persistPtyBinding({
        worktreeId: 'wt1',
        tabId: 'tab1',
        leafId: TEST_LEAF_2,
        ptyId: 'pty-split',
        expectedSourceBinding: {
          tabId: 'tab1',
          leafId: TEST_LEAF_1,
          ptyId: 'pty-source',
          incarnationId: 'different-incarnation'
        }
      })
    ).toBe(false)
    expect(store.getWorkspaceSession().terminalLayoutsByTabId.tab1.root).toEqual({
      type: 'leaf',
      leafId: TEST_LEAF_1
    })
  })

  it('requires an expected split source incarnation in the owning host partition', async () => {
    for (const hostId of [undefined, 'ssh:ssh-1']) {
      const store = await createStore()
      const sourceSession: WorkspaceSessionState = {
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
      }
      if (hostId) {
        store.setWorkspaceSession(
          {
            ...sourceSession,
            terminalPtyIncarnationsByPaneKey: {
              [`tab1:${TEST_LEAF_1}`]: 'live-incarnation'
            }
          },
          undefined
        )
      }
      store.setWorkspaceSession(sourceSession, hostId)

      expect(
        store.persistPtyBinding(
          {
            worktreeId: 'wt1',
            tabId: 'tab1',
            leafId: TEST_LEAF_2,
            ptyId: 'pty-split',
            expectedSourceBinding: {
              worktreeId: 'wt1',
              tabId: 'tab1',
              leafId: TEST_LEAF_1,
              ptyId: 'pty-source',
              incarnationId: 'live-incarnation'
            }
          },
          hostId
        )
      ).toBe(false)
      expect(store.getWorkspaceSession(hostId).terminalLayoutsByTabId.tab1.root).toEqual({
        type: 'leaf',
        leafId: TEST_LEAF_1
      })
    }
  })

  // Why: a session restored without an incarnation map still owns a valid source binding, so the
  // split path must be able to fence on the pane alone instead of an id persistence never recorded.
  it('admits a split whose source pane has no persisted incarnation', async () => {
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
      undefined
    )

    expect(
      store.persistPtyBinding({
        worktreeId: 'wt1',
        tabId: 'tab1',
        leafId: TEST_LEAF_2,
        ptyId: 'pty-split',
        expectedSourceBinding: {
          worktreeId: 'wt1',
          tabId: 'tab1',
          leafId: TEST_LEAF_1,
          ptyId: 'pty-source'
        }
      })
    ).toBe(true)
  })

  it('rejects competing PTY and incarnation changes during reconciliation', async () => {
    const store = await createStore()
    const paneKey = `tab1:${TEST_LEAF_1}`
    store.setWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {
        wt1: [makeTerminalTab({ id: 'tab1', worktreeId: 'wt1', ptyId: 'pty-current' })]
      },
      terminalLayoutsByTabId: {
        tab1: {
          root: { type: 'leaf', leafId: TEST_LEAF_1 },
          activeLeafId: TEST_LEAF_1,
          expandedLeafId: null,
          ptyIdsByLeafId: { [TEST_LEAF_1]: 'pty-current' }
        }
      },
      terminalPtyIncarnationsByPaneKey: { [paneKey]: 'inc-current' }
    })

    for (const competing of [
      { ptyId: 'pty-replaced', expectedIncarnationId: 'inc-current' },
      { ptyId: 'pty-current', expectedIncarnationId: 'inc-replaced' }
    ]) {
      expect(
        store.persistPtyBinding({
          worktreeId: 'wt1',
          tabId: 'tab1',
          leafId: TEST_LEAF_1,
          ptyId: competing.ptyId,
          incarnationId: 'inc-live',
          expectedBinding: {
            ptyId: competing.ptyId,
            incarnationId: competing.expectedIncarnationId
          }
        })
      ).toBe(false)
    }
    expect(store.getWorkspaceSession().terminalPtyIncarnationsByPaneKey?.[paneKey]).toBe(
      'inc-current'
    )
  })

  it('reconciles only the requested execution-host partition', async () => {
    const store = await createStore()
    const paneKey = `tab1:${TEST_LEAF_1}`
    const session = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {
        wt1: [makeTerminalTab({ id: 'tab1', worktreeId: 'wt1', ptyId: 'pty-1' })]
      },
      terminalLayoutsByTabId: {
        tab1: {
          root: { type: 'leaf' as const, leafId: TEST_LEAF_1 },
          activeLeafId: TEST_LEAF_1,
          expandedLeafId: null,
          ptyIdsByLeafId: { [TEST_LEAF_1]: 'pty-1' }
        }
      },
      terminalPtyIncarnationsByPaneKey: { [paneKey]: 'inc-stale' }
    }
    store.setWorkspaceSession(structuredClone(session), 'local')
    store.setWorkspaceSession(structuredClone(session), 'ssh:ssh-1')

    expect(
      store.persistPtyBinding(
        {
          worktreeId: 'wt1',
          tabId: 'tab1',
          leafId: TEST_LEAF_1,
          ptyId: 'pty-1',
          incarnationId: 'inc-remote-live',
          expectedBinding: { ptyId: 'pty-1', incarnationId: 'inc-stale' }
        },
        'ssh:ssh-1'
      )
    ).toBe(true)

    expect(store.getWorkspaceSession('local').terminalPtyIncarnationsByPaneKey?.[paneKey]).toBe(
      'inc-stale'
    )
    expect(store.getWorkspaceSession('ssh:ssh-1').terminalPtyIncarnationsByPaneKey?.[paneKey]).toBe(
      'inc-remote-live'
    )
  })

  it.each([
    { label: 'local', hostId: undefined },
    { label: 'SSH', hostId: 'ssh:ssh-1' }
  ])(
    'preserves a reconciled incarnation across a renderer snapshot ($label)',
    async ({ hostId }) => {
      const store = await createStore()
      const paneKey = `tab1:${TEST_LEAF_1}`
      store.setWorkspaceSession(
        {
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
        },
        hostId
      )

      expect(
        store.persistPtyBinding(
          {
            worktreeId: 'wt1',
            tabId: 'tab1',
            leafId: TEST_LEAF_1,
            ptyId: 'pty-1',
            incarnationId: 'inc-live',
            expectedBinding: { ptyId: 'pty-1', incarnationId: 'inc-stale' }
          },
          hostId
        )
      ).toBe(true)

      const rendererSnapshot = structuredClone(store.getWorkspaceSession(hostId))
      delete rendererSnapshot.terminalPtyIncarnationsByPaneKey
      delete rendererSnapshot.terminalTopologyRevisionByRepoId
      store.setWorkspaceSession(rendererSnapshot, hostId)

      expect(store.getWorkspaceSession(hostId).terminalPtyIncarnationsByPaneKey?.[paneKey]).toBe(
        'inc-live'
      )
      const reloaded = await createStore()
      expect(reloaded.getWorkspaceSession(hostId).terminalPtyIncarnationsByPaneKey?.[paneKey]).toBe(
        'inc-live'
      )
    }
  )

  it('rolls back incarnation reconciliation when the durability barrier fails', async () => {
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
    vi.spyOn(store, 'flushOrThrow').mockImplementationOnce(() => {
      throw new Error('disk full')
    })

    expect(() =>
      store.persistPtyBinding({
        worktreeId: 'wt1',
        tabId: 'tab1',
        leafId: TEST_LEAF_1,
        ptyId: 'pty-1',
        incarnationId: 'inc-live',
        expectedBinding: { ptyId: 'pty-1', incarnationId: 'inc-stale' }
      })
    ).toThrow('disk full')
    expect(store.getWorkspaceSession().terminalPtyIncarnationsByPaneKey?.[paneKey]).toBe(
      'inc-stale'
    )
  })
})
