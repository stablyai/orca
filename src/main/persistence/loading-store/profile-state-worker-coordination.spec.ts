import { describe, expect, it, vi } from 'vitest'
import { fixture } from './profile-state-delayed-authority-fixture'

export function registerProfileStateWorkerCoordinationTests(): void {
  describe('worker-owned Store writes', () => {
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
