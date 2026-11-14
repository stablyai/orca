import {
  closeTestStores,
  testState,
  type createStore,
  createStoreWithSshRemotePtyLeases
} from '../persistence-test-harness'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import '../../../shared/constants'
import '../../../shared/ssh-types'
import { TEST_LEAF_1, TEST_LEAF_2 } from '../persistence-session-fixtures'
import { PtyExitProof } from '../../pty/process-retirement/pty-exit-proof'

const { loadUserSshConfigMock, sshConfigHostsToTargetsMock } = vi.hoisted(() => ({
  loadUserSshConfigMock: vi.fn(),
  sshConfigHostsToTargetsMock: vi.fn()
}))

vi.mock('../../ssh/config/ssh-config-parser', () => ({
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

vi.mock('../../telemetry/client', () => ({
  track: trackMock
}))

vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: getCohortAtEmitMock
}))

async function storeWithBoundSshPane(): Promise<Awaited<ReturnType<typeof createStore>>> {
  const store = createStoreWithSshRemotePtyLeases([
    {
      targetId: 'ssh-1',
      ptyId: 'remote-pty',
      worktreeId: 'wt1',
      tabId: 'tab1',
      leafId: TEST_LEAF_1,
      state: 'attached'
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

  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  // Expired leases still prove a sibling may run remotely; terminated leases must not restore its binding.
  it.each([
    ['expired', { [TEST_LEAF_1]: 'remote-pty-1', [TEST_LEAF_2]: 'remote-pty-2' }],
    ['terminated', { [TEST_LEAF_1]: 'remote-pty-1' }]
  ] as const)(
    'repairs a partial renderer snapshot for a %s sibling lease only when it is not terminated',
    async (siblingState, expected) => {
      const store = createStoreWithSshRemotePtyLeases([
        {
          targetId: 'ssh-1',
          ptyId: 'remote-pty-1',
          worktreeId: 'wt1',
          tabId: 'tab1',
          leafId: TEST_LEAF_1,
          state: 'detached'
        },
        {
          targetId: 'ssh-1',
          ptyId: 'remote-pty-2',
          worktreeId: 'wt1',
          tabId: 'tab1',
          leafId: TEST_LEAF_2,
          state: siblingState
        }
      ])
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

  it('clears workspace bindings when marking an SSH remote PTY lease terminated', async () => {
    const store = await storeWithBoundSshPane()

    store.markSshRemotePtyLease(
      'ssh-1',
      'ssh:ssh-1@@remote-pty',
      PtyExitProof.from('exit-observed', undefined)
    )

    const session = store.getWorkspaceSession()
    expect(store.getSshRemotePtyLeases('ssh-1')).toEqual([])
    expect(session.tabsByWorktree.wt1[0].ptyId).toBeNull()
    expect(session.terminalLayoutsByTabId.tab1.ptyIdsByLeafId).toEqual({})
  })
})
