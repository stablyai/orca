import { describe, expect, it, vi } from 'vitest'
import {
  createWorkerMaintenanceFixture,
  maintenanceBarrier
} from './profile-state-maintenance-fixture'

export function registerProfileStateMaintenanceRecoveryTests(): void {
  describe('failed maintenance recovery', () => {
    it('cancels between checkpoints without aborting an acknowledged write', async () => {
      const { store, authority, readState } = await createWorkerMaintenanceFixture()
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const started = maintenanceBarrier()
      const release = maintenanceBarrier()
      const write = authority.writeCompleteSerializedDomains.bind(authority)
      vi.spyOn(authority, 'writeCompleteSerializedDomains').mockImplementationOnce(
        async (domains) => {
          started.resolve()
          await release.promise
          await write(domains)
        }
      )
      const abort = vi.spyOn(authority, 'abort')
      const controller = new AbortController()
      store.updateSettings({ theme: 'dark' })
      const pending = store.beginProfileMaintenance({ signal: controller.signal })
      const rejected = expect(pending).rejects.toThrow('aborted')
      await started.promise
      controller.abort()
      release.resolve()
      await rejected
      expect(abort).not.toHaveBeenCalled()
      store.setWorkspaceSession({
        ...store.getWorkspaceSession(),
        activeTabId: 'after-cancellation'
      })
      await store.flushPendingOrThrowAsync()
      expect(readState()).toMatchObject({
        settings: { theme: 'dark' },
        workspaceSession: { activeTabId: 'after-cancellation' }
      })
    })

    it('keeps changed storage fenced when recovering a known failure', async () => {
      const { store, authority, peer, readState } = await createWorkerMaintenanceFixture()
      vi.spyOn(console, 'error').mockImplementation(() => {})
      store.updateSettings({ theme: 'dark' })
      vi.spyOn(authority, 'writeCompleteSerializedDomains').mockImplementationOnce(async () => {
        const writer = peer()
        writer.writeSerializedDomains([{ domain: 'peer', payload: '{"preserved":true}' }])
        writer.close()
        throw new Error('disk refused')
      })
      await expect(store.beginProfileMaintenance()).rejects.toThrow('disk refused')
      await expect(store.runDurableMutation(() => ({ value: undefined }))).rejects.toThrow(
        'finalized'
      )
      expect(readState().peer).toEqual({ preserved: true })
    })
  })
}
