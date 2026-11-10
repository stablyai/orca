import { describe, expect, it, vi } from 'vitest'
import { fixture } from './profile-state-delayed-authority-fixture'
import { recordRemoteLayoutFrame } from '../../remote-layout-snapshot/remote-layout-snapshot-recorder'

export function registerProfileStateWorkerCoordinationTests(): void {
  describe('worker-owned Store writes', () => {
    it('retains a later remote workspace edit after an older snapshot commit', async () => {
      const { store, authority, readState } = await fixture()
      const record = (title: string) =>
        recordRemoteLayoutFrame(store, 'env', 'session.tabs.subscribeAll', {
          id: 'stream',
          ok: true,
          _meta: { runtimeId: 'test' },
          result: {
            type: 'updated',
            worktree: 'workspace',
            tabs: [{ type: 'terminal', id: 'tab', title }]
          }
        })
      record('first')
      const gate = authority.pause()
      const first = store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
      await gate.started.promise
      record('second')
      gate.finish.resolve()
      await first
      expect(readState().remoteLayoutSnapshots.env.workspaces.workspace.tabs).toEqual([
        { type: 'terminal', id: 'tab', title: 'first' }
      ])
      await store.flushPendingOrThrowAsync()
      expect(readState().remoteLayoutSnapshots.env.workspaces.workspace.tabs).toEqual([
        { type: 'terminal', id: 'tab', title: 'second' }
      ])
    })

    it('restores failed remote snapshot intent alongside a newer edit', async () => {
      const { store, authority, readState } = await fixture()
      vi.spyOn(console, 'error').mockImplementation(() => {})
      recordRemoteLayoutFrame(store, 'env', 'session.tabs.subscribeAll', {
        id: 'stream',
        ok: true,
        _meta: { runtimeId: 'test' },
        result: { type: 'snapshots', snapshots: [{ worktree: 'a', tabs: [] }] }
      })
      const gate = authority.pause()
      const first = store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
      const rejected = expect(first).rejects.toThrow('disk refused')
      await gate.started.promise
      recordRemoteLayoutFrame(store, 'env', 'session.tabs.subscribeAll', {
        id: 'stream',
        ok: true,
        _meta: { runtimeId: 'test' },
        result: { type: 'updated', worktree: 'b', tabs: [] }
      })
      gate.finish.reject(new Error('disk refused'))
      await rejected
      await store.flushPendingOrThrowAsync()
      expect(readState().remoteLayoutSnapshots).toEqual({
        env: { workspaces: { a: { worktree: 'a', tabs: [] }, b: { worktree: 'b', tabs: [] } } }
      })
    })

    it('retains a newer edit after an older write is acknowledged', async () => {
      const { store, authority, readState } = await fixture()
      const gate = authority.pause()
      store.updateSettings({ theme: 'dark' })
      const first = store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
      await gate.started.promise
      store.updateSettings({ theme: 'light' })
      gate.finish.resolve()
      await first
      expect(readState().settings.theme).toBe('dark')
      await store.flushPendingOrThrowAsync()
      expect(readState().settings.theme).toBe('light')
    })

    it('merges a failed older write with dirty state added while it was in flight', async () => {
      const { store, authority, readState } = await fixture()
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const gate = authority.pause()
      store.updateSettings({ theme: 'dark' })
      const first = store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
      const rejected = expect(first).rejects.toThrow('disk refused')
      await gate.started.promise
      store.getWorkspaceSession().activeTabId = 'newer-tab'
      store.setWorkspaceSession(store.getWorkspaceSession())
      gate.finish.reject(new Error('disk refused'))
      await rejected
      await store.flushPendingOrThrowAsync()
      expect(readState()).toMatchObject({
        settings: { theme: 'dark' },
        workspaceSession: { activeTabId: 'newer-tab' }
      })
    })

    it('reserves ordering before an exact mutation changes live state', async () => {
      const { store, authority, readState } = await fixture()
      const gate = authority.pause()
      store.updateSettings({ theme: 'dark' })
      const first = store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
      await gate.started.promise
      const mutate = vi.fn(() => {
        store.updateSettings({ theme: 'light' })
        return { value: 'durable' }
      })
      const exact = store.runDurableMutation(mutate)
      await Promise.resolve()
      expect(mutate).not.toHaveBeenCalled()
      expect(store.getSettings().theme).toBe('dark')
      gate.finish.resolve()
      await first
      await expect(exact).resolves.toBe('durable')
      expect(readState().settings.theme).toBe('light')
    })
  })
}
