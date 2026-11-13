import { closeTestStores, testState, createStore } from '../../persistence-test-harness'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TEST_LEAF_1 } from '../../persistence-session-fixtures'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'

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

  // Lease expiry means lost routing, not shell exit; retain the binding for reattachment.
})
