import { describe, expect, it, vi } from 'vitest'
import { TEST_LEAF_1, TEST_LEAF_2 } from '../../persistence-session-fixtures'
import { ProfileStateWriterError } from '../../profile-state/writer/profile-state-writer-errors'
import { fixture } from '../profile-writing/profile-state-delayed-authority-fixture'

export function registerPtyBindingAsyncDurabilityTests(): void {
  const binding = {
    worktreeId: 'repo-local::/fixture/local',
    tabId: 'async-binding-tab',
    leafId: TEST_LEAF_1,
    ptyId: 'async-binding-pty',
    incarnationId: 'async-binding-incarnation'
  }

  describe('durable asynchronous PTY binding', () => {
    it('acknowledges only after the binding reaches SQLite', async () => {
      const { store, authority, readState } = await fixture()
      store.getWorkspaceSession().activeWorktreeIdsOnShutdown = []
      await store.flushPendingOrThrowAsync()
      const gate = authority.pause()
      let acknowledged = false
      const pending = store.persistPtyBinding(binding).then((result) => {
        acknowledged = true
        return result
      })
      await gate.started.promise
      expect(acknowledged).toBe(false)
      expect(readState().workspaceSession.terminalLayoutsByTabId[binding.tabId]).toBeUndefined()
      expect(readState().workspaceSession.activeWorktreeIdsOnShutdown).toEqual([])
      gate.finish.resolve()
      expect(await pending).toBe(true)
      expect(
        readState().workspaceSession.terminalLayoutsByTabId[binding.tabId].ptyIdsByLeafId
      ).toEqual({
        [binding.leafId]: binding.ptyId
      })
      expect(readState().workspaceSession.activeWorktreeIdsOnShutdown).toEqual([binding.worktreeId])
    })

    it('retains a newer root sibling when rolling back a failed leaf replacement', async () => {
      const { store, authority, readState } = await fixture()
      vi.spyOn(console, 'error').mockImplementation(() => {})
      await store.persistPtyBinding(binding)
      const gate = authority.pause()
      const rejected = expect(
        store.persistPtyBinding({ ...binding, ptyId: 'failed-replacement' })
      ).rejects.toThrow('disk refused')
      await gate.started.promise
      const session = store.getWorkspaceSession()
      const tab = session.tabsByWorktree[binding.worktreeId].find(
        (candidate) => candidate.id === binding.tabId
      )
      if (!tab) {
        throw new Error('binding did not create its terminal row')
      }
      const layout = session.terminalLayoutsByTabId[binding.tabId]
      layout.root = {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', leafId: TEST_LEAF_2 },
        second: { type: 'leaf', leafId: binding.leafId }
      }
      layout.ptyIdsByLeafId = { ...layout.ptyIdsByLeafId, [TEST_LEAF_2]: 'new-root-pty' }
      tab.ptyId = 'new-root-pty'
      const expectedRoot = structuredClone(layout.root)
      gate.finish.reject(
        new ProfileStateWriterError('test-disk-failure', 'disk refused', 'known-failure')
      )
      await rejected
      await store.flushPendingOrThrowAsync()
      const persisted = readState().workspaceSession
      expect(persisted.terminalLayoutsByTabId[binding.tabId].root).toEqual(expectedRoot)
      expect(persisted.terminalLayoutsByTabId[binding.tabId].ptyIdsByLeafId).toEqual({
        [binding.leafId]: binding.ptyId,
        [TEST_LEAF_2]: 'new-root-pty'
      })
      expect(persisted.tabsByWorktree[binding.worktreeId]).toContainEqual(
        expect.objectContaining({ id: binding.tabId, ptyId: 'new-root-pty' })
      )
    })
  })
}
