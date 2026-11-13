import {
  closeTestStores,
  testState,
  createStore,
  createStoreWithSshRemotePtyLeases
} from '../../persistence-test-harness'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TEST_LEAF_1 } from '../../persistence-session-fixtures'

const { loadUserSshConfigMock, sshConfigHostsToTargetsMock } = vi.hoisted(() => ({
  loadUserSshConfigMock: vi.fn(),
  sshConfigHostsToTargetsMock: vi.fn()
}))

vi.mock('../../../ssh/config/ssh-config-parser', () => ({
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

vi.mock('../../../telemetry/client', () => ({
  track: trackMock
}))

vi.mock('../../../telemetry/cohort-classifier', () => ({
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
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })
  it('drops legacy leaf-keyed records from mixed-version writes before binding preservation', async () => {
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
            ptyId: 'daemon-pty'
          }
        ]
      },
      terminalLayoutsByTabId: {
        tab1: {
          root: { type: 'leaf', leafId: TEST_LEAF_1 },
          activeLeafId: TEST_LEAF_1,
          expandedLeafId: null,
          ptyIdsByLeafId: { [TEST_LEAF_1]: 'daemon-pty' },
          buffersByLeafId: { [TEST_LEAF_1]: 'Current buffer' },
          titlesByLeafId: { [TEST_LEAF_1]: 'Current' }
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
          root: { type: 'leaf', leafId: TEST_LEAF_1 },
          activeLeafId: 'pane:1',
          expandedLeafId: 'pane:1',
          ptyIdsByLeafId: { 'pane:1': 'stale-pty' },
          buffersByLeafId: { 'pane:1': 'Stale buffer' },
          titlesByLeafId: { 'pane:1': 'Stale' }
        }
      }
    })

    const session = store.getWorkspaceSession()
    const layout = session.terminalLayoutsByTabId.tab1
    expect(layout.activeLeafId).toBe(TEST_LEAF_1)
    expect(layout.expandedLeafId).toBeNull()
    expect(layout.ptyIdsByLeafId).toEqual({ [TEST_LEAF_1]: 'daemon-pty' })
    expect(layout.buffersByLeafId).toBeUndefined()
    expect(layout.scrollbackRefsByLeafId).toEqual({
      [TEST_LEAF_1]: expect.stringMatching(/^v1-[0-9a-f]{32}$/)
    })
    const ref = layout.scrollbackRefsByLeafId?.[TEST_LEAF_1]
    expect(ref ? store.readTerminalScrollbackSnapshot(ref) : null).toBe('Current buffer')
    expect(layout.titlesByLeafId).toEqual({ [TEST_LEAF_1]: 'Current' })
    expect(session.tabsByWorktree.wt1[0].ptyId).toBe('daemon-pty')
  })

  // Expired means reattach gave up; the remote shell can still be alive and need its binding.

  it('does not restore cleared SSH bindings after a lease was terminated', async () => {
    const store = createStoreWithSshRemotePtyLeases([
      {
        targetId: 'ssh-1',
        ptyId: 'remote-pty',
        worktreeId: 'wt1',
        tabId: 'tab1',
        leafId: TEST_LEAF_1,
        state: 'terminated'
      }
    ])
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
          root: { type: 'leaf', leafId: TEST_LEAF_1 },
          activeLeafId: TEST_LEAF_1,
          expandedLeafId: null,
          ptyIdsByLeafId: {}
        }
      }
    })

    const session = store.getWorkspaceSession()
    expect(session.tabsByWorktree.wt1[0].ptyId).toBeNull()
    expect(session.terminalLayoutsByTabId.tab1.ptyIdsByLeafId).toEqual({})
  })
})
