import { describe, expect, it, vi } from 'vitest'
import { toSshExecutionHostId } from '../../../shared/execution-host'
import { retirePersistedStablePaneOwner } from '../../ipc/pty/pane/stable-owner'
import { TEST_LEAF_1 } from '../../persistence-session-fixtures'
import { retireTerminalSurfaceFromPersistence } from '../../runtime/mobile-session-terminal-persistence-retirement'
import { ProfileStateWriterError } from '../profile-state/profile-state-writer-errors'
import { fixture } from './profile-state-delayed-authority-fixture'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../ssh/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

const binding = {
  worktreeId: 'repo-local::/fixture/local',
  tabId: 'retirement-tab',
  leafId: TEST_LEAF_1,
  ptyId: 'retirement-pty',
  incarnationId: 'retirement-incarnation'
}

async function retirementFixture(connectionId: string | undefined) {
  const result = await fixture()
  const hostId = connectionId ? toSshExecutionHostId(connectionId) : undefined
  await result.store.persistPtyBinding(binding, hostId)
  return {
    ...result,
    retire: () =>
      retirePersistedStablePaneOwner(
        result.store,
        { ...binding, persistedIncarnationId: binding.incarnationId },
        binding.worktreeId,
        connectionId
      ),
    removeInMemory: () => {
      result.store.setWorkspaceSession(
        retireTerminalSurfaceFromPersistence(result.store.getWorkspaceSession(hostId), {
          ...binding,
          parentTabId: binding.tabId
        }),
        hostId
      )
    },
    persistedLayout: () => {
      const state = result.readState()
      const session = hostId ? state.workspaceSessionsByHostId[hostId] : state.workspaceSession
      return session.terminalLayoutsByTabId[binding.tabId]
    }
  }
}

describe.each([undefined, 'retirement-ssh'])(
  'durable PTY retirement on host %s',
  (connectionId) => {
    it('waits for an already removed in-memory pane to reach SQLite', async () => {
      const { authority, retire, removeInMemory, persistedLayout } =
        await retirementFixture(connectionId)
      removeInMemory()
      expect(persistedLayout()?.ptyIdsByLeafId).toEqual({ [binding.leafId]: binding.ptyId })
      const gate = authority.pause()
      let acknowledged = false
      const pending = retire().then((accepted) => {
        acknowledged = true
        return accepted
      })
      try {
        await Promise.race([gate.started.promise, pending])
        expect(acknowledged).toBe(false)
        expect(persistedLayout()?.ptyIdsByLeafId).toEqual({ [binding.leafId]: binding.ptyId })
      } finally {
        gate.finish.resolve()
      }
      await expect(pending).resolves.toBe(true)
      expect(persistedLayout()).toBeUndefined()
    })

    it('rejects when a pending removal cannot reach SQLite and retains it for retry', async () => {
      const { authority, retire, removeInMemory, persistedLayout } =
        await retirementFixture(connectionId)
      vi.spyOn(console, 'error').mockImplementation(() => {})
      removeInMemory()
      const gate = authority.pause()
      const rejected = expect(retire()).rejects.toThrow('retirement disk refused')
      try {
        await Promise.race([gate.started.promise, rejected])
        gate.finish.reject(
          new ProfileStateWriterError(
            'test-disk-failure',
            'retirement disk refused',
            'known-failure'
          )
        )
        await rejected
      } finally {
        gate.finish.resolve()
      }
      expect(persistedLayout()?.ptyIdsByLeafId).toEqual({ [binding.leafId]: binding.ptyId })
      await expect(retire()).resolves.toBe(true)
      expect(persistedLayout()).toBeUndefined()
    })

    it('skips disk work when the pane removal is already durable', async () => {
      const { authority, retire, persistedLayout } = await retirementFixture(connectionId)
      await expect(retire()).resolves.toBe(true)
      expect(persistedLayout()).toBeUndefined()
      authority.captures.length = 0
      const revisionCheck = vi.spyOn(authority, 'assertCurrentRevision')
      const fullStateWrite = vi.spyOn(authority, 'writeSerializedState')
      await expect(retire()).resolves.toBe(true)
      expect(authority.captures).toEqual([])
      expect(revisionCheck).not.toHaveBeenCalled()
      expect(fullStateWrite).not.toHaveBeenCalled()
    })
  }
)
