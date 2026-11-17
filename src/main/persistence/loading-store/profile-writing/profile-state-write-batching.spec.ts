import { describe, expect, it, vi } from 'vitest'
import { fixture } from './profile-state-delayed-authority-fixture'

export function registerProfileStateWriteBatchingTests(): void {
  describe('queued worker snapshot batching', () => {
    it('upgrades a queued debounce to capture an explicit getter-only flush', async () => {
      const { store, authority, readState } = await fixture()
      const gate = authority.pause()
      vi.useFakeTimers()
      try {
        const first = store.runDurableMutation(() => {
          store.updateSettings({ theme: 'dark' })
          return { value: undefined }
        })
        await gate.started.promise
        await vi.advanceTimersByTimeAsync(1_000)
        store.getWorkspaceSession().activeTabId = 'explicit-edit'
        const explicit = store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
        gate.finish.resolve()
        await Promise.all([first, explicit])
        expect(readState().workspaceSession.activeTabId).toBe('explicit-edit')
      } finally {
        gate.finish.resolve()
        vi.useRealTimers()
      }
    })

    it('keeps a later flush ordered after an intervening durable mutation', async () => {
      const { store, authority, readState } = await fixture()
      const gate = authority.pause()
      store.updateSettings({ theme: 'dark' })
      const first = store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
      await gate.started.promise
      const before = store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
      const mutation = store.runDurableMutation(() => {
        store.updateSettings({ theme: 'light' })
        return { value: undefined }
      })
      const after = store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
      const verifyAfter = after.then(() => expect(readState().settings.theme).toBe('light'))
      gate.finish.resolve()
      await Promise.all([first, before, mutation, verifyAfter])
    })

    it('shares a queued write failure with its waiters and allows a fresh retry', async () => {
      const { store, authority, readState } = await fixture()
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const gate = authority.pause()
      store.updateSettings({ theme: 'dark' })
      const first = store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
      await gate.started.promise
      store.updateSettings({ theme: 'light' })
      const failed = [
        store.flushPendingOrThrowAsync({ drainToStableGeneration: false }),
        store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
      ].map((waiter) => expect(waiter).rejects.toThrow('disk refused'))
      vi.spyOn(authority, 'writeCompleteSerializedDomains').mockRejectedValueOnce(
        new Error('disk refused')
      )
      gate.finish.resolve()
      await Promise.all([first, ...failed])
      await store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
      expect(readState().settings.theme).toBe('light')
    })
  })
}
