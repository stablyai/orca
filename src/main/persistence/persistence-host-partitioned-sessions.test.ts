import { toSshExecutionHostId } from '../../shared/execution-host'
import { hostWorktreeTarget } from '../../shared/worktree/host-qualified-identity'
import {
  closeTestStores,
  testState,
  createStore,
  makeRepo,
  makeWorktreeLineage,
  makeWorkspaceLineage
} from './persistence-test-harness'
import { makeTerminalTab } from './persistence-session-fixtures'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { WorkspaceSessionState } from '../../shared/workspace-session/workspace-session-state-types'
import { getDefaultWorkspaceSession } from '../../shared/constants'

import { worktreeWorkspaceKey } from '../../shared/workspace-scope'

const { loadUserSshConfigMock, sshConfigHostsToTargetsMock } = vi.hoisted(() => ({
  loadUserSshConfigMock: vi.fn(),
  sshConfigHostsToTargetsMock: vi.fn()
}))

vi.mock('../ssh/config/ssh-config-parser', () => ({
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

vi.mock('../telemetry/client', () => ({
  track: trackMock
}))

vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: getCohortAtEmitMock
}))

describe('Store host-partitioned workspace sessions', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
  })

  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  const makeHostSession = (activeRepoId: string): WorkspaceSessionState => ({
    ...getDefaultWorkspaceSession(),
    activeRepoId
  })

  it('preserves and enforces equal repo-id topology authority independently per host', async () => {
    const store = await createStore()
    const worktreeId = 'duplicate::/worktree'
    const staleTabs = {
      [worktreeId]: [makeTerminalTab({ id: 'stale-tab', worktreeId, ptyId: 'stale-pty' })]
    }
    store.setWorkspaceSession(
      {
        ...getDefaultWorkspaceSession(),
        terminalTopologyRevisionByRepoId: { duplicate: 2 }
      },
      'runtime:env-a'
    )
    store.setWorkspaceSession(
      {
        ...getDefaultWorkspaceSession(),
        tabsByWorktree: {
          [worktreeId]: [makeTerminalTab({ id: 'live-tab', worktreeId, ptyId: 'live-pty' })]
        },
        terminalTopologyRevisionByRepoId: { duplicate: 7 }
      },
      'runtime:env-b'
    )

    store.setWorkspaceSession(
      { ...getDefaultWorkspaceSession(), tabsByWorktree: staleTabs },
      'runtime:env-a'
    )
    store.patchWorkspaceSession({ tabsByWorktree: staleTabs }, 'runtime:env-a')

    expect(store.getWorkspaceSession('runtime:env-a').tabsByWorktree[worktreeId]).toEqual([])
    expect(
      store.getWorkspaceSession('runtime:env-a').terminalTopologyRevisionByRepoId?.duplicate
    ).toBe(2)
    expect(store.getWorkspaceSession('runtime:env-b').tabsByWorktree[worktreeId]?.[0]?.id).toBe(
      'live-tab'
    )
    expect(
      store.getWorkspaceSession('runtime:env-b').terminalTopologyRevisionByRepoId?.duplicate
    ).toBe(7)
  })

  it('preserves a same-id persisted owner when another qualified host is removed', async () => {
    const store = await createStore()
    const worktreeId = 'repo-split::/workspace/stale'
    const session = {
      ...makeHostSession('repo-split'),
      tabsByWorktree: {
        [worktreeId]: [makeTerminalTab({ id: 'stale-tab', worktreeId })]
      }
    }
    store.setWorkspaceSession(session, 'local')
    store.setWorkspaceSession(session, 'runtime:env-b')
    store.setWorktreeMeta(hostWorktreeTarget({ id: worktreeId, hostId: 'local' }), {
      hostId: 'local'
    })
    const worktreeLineage = makeWorktreeLineage({ worktreeId })
    const workspaceLineage = makeWorkspaceLineage({
      childWorkspaceKey: worktreeWorkspaceKey(worktreeId)
    })
    store.setWorktreeLineage(
      hostWorktreeTarget({ id: worktreeId, hostId: 'local' }),
      worktreeLineage
    )
    store.setWorkspaceLineage(workspaceLineage)

    // A same-ID local metadata row must not redirect removal away from the confirmed remote host.
    store.removeWorktreeMeta(hostWorktreeTarget({ id: worktreeId, hostId: 'runtime:env-b' }))

    expect(store.getWorktreeMeta(worktreeId)?.hostId).toBe('local')
    expect(store.getWorktreeLineage(worktreeId)).toEqual(worktreeLineage)
    expect(store.getWorkspaceLineage(workspaceLineage.childWorkspaceKey)).toEqual(workspaceLineage)
    expect(store.getWorkspaceSession('local').tabsByWorktree[worktreeId]).toHaveLength(1)
    expect(store.getWorkspaceSession('runtime:env-b').tabsByWorktree[worktreeId]).toBeUndefined()
  })

  it('preserves a surviving local session when removed-host metadata owns the shared id', async () => {
    const store = await createStore()
    const worktreeId = 'repo-split::/workspace/stale'
    store.addRepo(makeRepo({ id: 'repo-split', path: '/local/repo' }))
    store.addRepo(
      makeRepo({
        id: 'repo-split',
        path: '/remote/repo',
        connectionId: 'ssh-b',
        executionHostId: 'ssh:ssh-b'
      })
    )
    const localSession = {
      ...makeHostSession('repo-split'),
      tabsByWorktree: {
        [worktreeId]: [makeTerminalTab({ id: 'same-id-local-tab', worktreeId })]
      }
    }
    const remoteSession = {
      ...makeHostSession('repo-split'),
      tabsByWorktree: {
        [worktreeId]: [makeTerminalTab({ id: 'removed-remote-tab', worktreeId })]
      }
    }
    store.setWorkspaceSession(localSession, 'local')
    store.setWorkspaceSession(remoteSession, 'ssh:ssh-b')
    store.setWorktreeMeta(hostWorktreeTarget({ id: worktreeId, hostId: 'ssh:ssh-b' }), {
      hostId: 'ssh:ssh-b'
    })

    store.removeWorktreeMeta(hostWorktreeTarget({ id: worktreeId, hostId: 'ssh:ssh-b' }))

    expect(store.getWorkspaceSession('local').tabsByWorktree[worktreeId]).toEqual([
      expect.objectContaining({ id: 'same-id-local-tab' })
    ])
    expect(store.getWorkspaceSession('ssh:ssh-b').tabsByWorktree[worktreeId]).toBeUndefined()
    expect(store.getWorktreeMeta(worktreeId)).toBeUndefined()
  })

  it("removing one SSH host's copy leaves a same-id copy on another SSH host", async () => {
    const store = await createStore()
    const worktreeId = 'repo-twin::/workspace/shared'
    const session = {
      ...makeHostSession('repo-twin'),
      tabsByWorktree: { [worktreeId]: [makeTerminalTab({ id: 'twin-tab', worktreeId })] }
    }
    store.setWorkspaceSession(session, toSshExecutionHostId('ssh-a'))
    store.setWorkspaceSession(session, toSshExecutionHostId('ssh-b'))

    store.removeWorkspaceSessionStateForWorktree(
      hostWorktreeTarget({ id: worktreeId, hostId: toSshExecutionHostId('ssh-a') })
    )

    const tabsOn = (host: string) => store.getWorkspaceSession(host).tabsByWorktree[worktreeId]
    expect(tabsOn(toSshExecutionHostId('ssh-a'))).toBeUndefined()
    expect(tabsOn(toSshExecutionHostId('ssh-b'))?.[0]?.id).toBe('twin-tab')
  })

  // Fencing an unwritten host partition would rebase sibling worktrees onto empty state.
  it('does not fence a delayed session write when its host partition was never persisted', async () => {
    const store = await createStore()
    const worktreeId = 'repo-gone::/workspace/stale'
    const delayedSession = {
      ...makeHostSession('repo-gone'),
      tabsByWorktree: {
        [worktreeId]: [makeTerminalTab({ id: 'stale-tab', worktreeId })]
      }
    }

    store.removeWorkspaceSessionStateForWorktree(
      hostWorktreeTarget({ id: worktreeId, hostId: 'runtime:env-a' })
    )
    store.setWorkspaceSession(delayedSession, 'runtime:env-a')

    const session = store.getWorkspaceSession('runtime:env-a')
    expect(session.tabsByWorktree[worktreeId]?.[0]?.id).toBe('stale-tab')
    expect(session.terminalTopologyRevisionByRepoId?.['repo-gone']).toBeUndefined()
  })
})
