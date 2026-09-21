import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { WorkspaceSessionState } from '../shared/workspace-session-state-types'
import { getDefaultWorkspaceSession } from '../shared/constants'
import { testState, createStore } from './persistence-test-harness'
import { TEST_LEAF_1 } from './persistence-session-fixtures'

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

describe('Store SSH remote PTY bindings across host partitions', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  const makeBoundHostSession = (ptyId: string | null): WorkspaceSessionState => ({
    ...getDefaultWorkspaceSession(),
    activeRepoId: 'repo-1',
    activeWorktreeId: 'repo-1::/worktree',
    activeTabId: 'tab-1',
    tabsByWorktree: {
      'repo-1::/worktree': [
        {
          id: 'tab-1',
          worktreeId: 'repo-1::/worktree',
          title: 'Terminal',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1,
          ptyId
        }
      ]
    },
    terminalLayoutsByTabId: {
      'tab-1': {
        root: { type: 'leaf', leafId: TEST_LEAF_1 },
        activeLeafId: TEST_LEAF_1,
        expandedLeafId: null,
        ptyIdsByLeafId: ptyId ? { [TEST_LEAF_1]: ptyId } : {}
      }
    }
  })

  it('persists an SSH PTY binding only in the SSH host partition', async () => {
    const store = await createStore()
    store.setWorkspaceSession(makeBoundHostSession(null), 'local')
    store.setWorkspaceSession(makeBoundHostSession(null), 'ssh:ssh-1')

    store.persistPtyBinding(
      {
        worktreeId: 'repo-1::/worktree',
        tabId: 'tab-1',
        leafId: TEST_LEAF_1,
        ptyId: 'ssh:ssh-1@@remote-pty'
      },
      'ssh:ssh-1'
    )

    expect(
      store.getWorkspaceSession('ssh:ssh-1').tabsByWorktree['repo-1::/worktree'][0]?.ptyId
    ).toBe('ssh:ssh-1@@remote-pty')
    expect(
      store.getWorkspaceSession('local').tabsByWorktree['repo-1::/worktree'][0]?.ptyId
    ).toBeNull()
  })

  it('rolls back a failed SSH PTY binding flush in the SSH host partition', async () => {
    const store = await createStore()
    store.setWorkspaceSession(makeBoundHostSession(null), 'local')
    store.setWorkspaceSession(makeBoundHostSession(null), 'ssh:ssh-1')
    const flush = vi.spyOn(store, 'flushOrThrow').mockImplementationOnce(() => {
      throw new Error('disk unavailable')
    })

    expect(() =>
      store.persistPtyBinding(
        {
          worktreeId: 'repo-1::/worktree',
          tabId: 'tab-1',
          leafId: TEST_LEAF_1,
          ptyId: 'ssh:ssh-1@@remote-pty'
        },
        'ssh:ssh-1'
      )
    ).toThrow('disk unavailable')
    flush.mockRestore()

    expect(
      store.getWorkspaceSession('ssh:ssh-1').tabsByWorktree['repo-1::/worktree'][0]?.ptyId
    ).toBeNull()
    expect(
      store.getWorkspaceSession('local').tabsByWorktree['repo-1::/worktree'][0]?.ptyId
    ).toBeNull()
  })

  it('clears terminated SSH PTY bindings from the SSH partition and legacy local copy', async () => {
    const store = await createStore()
    const ptyId = 'ssh:ssh-1@@remote-pty'
    store.setWorkspaceSession(makeBoundHostSession(ptyId), 'local')
    store.setWorkspaceSession(makeBoundHostSession(ptyId), 'ssh:ssh-1')
    store.upsertSshRemotePtyLease({
      targetId: 'ssh-1',
      ptyId: 'remote-pty',
      worktreeId: 'repo-1::/worktree',
      tabId: 'tab-1',
      leafId: TEST_LEAF_1,
      state: 'attached'
    })

    store.markSshRemotePtyLease('ssh-1', ptyId, 'terminated')

    for (const hostId of ['local', 'ssh:ssh-1']) {
      const session = store.getWorkspaceSession(hostId)
      expect(session.tabsByWorktree['repo-1::/worktree'][0]?.ptyId).toBeNull()
      expect(session.terminalLayoutsByTabId['tab-1']?.ptyIdsByLeafId).toEqual({})
    }
  })

  // `expired` only records that the client lost its route, so both partitions keep the binding the
  // pane needs to reattach to a remote shell nothing has attested is dead.
  it('keeps expired SSH PTY bindings in the SSH partition and legacy local copy', async () => {
    const store = await createStore()
    const ptyId = 'ssh:ssh-1@@remote-pty'
    store.setWorkspaceSession(makeBoundHostSession(ptyId), 'local')
    store.setWorkspaceSession(makeBoundHostSession(ptyId), 'ssh:ssh-1')
    store.upsertSshRemotePtyLease({
      targetId: 'ssh-1',
      ptyId: 'remote-pty',
      worktreeId: 'repo-1::/worktree',
      tabId: 'tab-1',
      leafId: TEST_LEAF_1,
      state: 'attached'
    })

    store.markSshRemotePtyLease('ssh-1', ptyId, 'expired')

    for (const hostId of ['local', 'ssh:ssh-1']) {
      const session = store.getWorkspaceSession(hostId)
      expect(session.tabsByWorktree['repo-1::/worktree'][0]?.ptyId).toBe(ptyId)
      expect(session.terminalLayoutsByTabId['tab-1']?.ptyIdsByLeafId).toEqual({
        [TEST_LEAF_1]: ptyId
      })
    }
  })
})
