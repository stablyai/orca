import 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import '../../preferences/active-view-preference'
import '../../profile-state/legacy-json/profile-state-export-path'
import { createWorkerMaintenanceFixture } from './profile-state-maintenance-fixture'

export function registerProfileStateMaintenanceTests(): void {
  describe('profile maintenance admission', () => {
    it('refuses re-admission after a competing write without adopting its revision', async () => {
      const { store, peer, readState } = await createWorkerMaintenanceFixture()
      store.updateSettings({ theme: 'dark' })
      const maintenance = await store.beginProfileMaintenance()
      const writer = peer()
      try {
        writer.readSerializedState()
        writer.writeSerializedDomains([{ domain: 'peer', payload: '{"preserved":true}' }])
      } finally {
        writer.close()
      }
      await expect(maintenance.resume()).rejects.toThrow('Profile state revision changed')
      const mutate = vi.fn(() => ({ value: undefined }))
      await expect(store.runDurableMutation(mutate)).rejects.toThrow('finalized')
      expect(mutate).not.toHaveBeenCalled()
      expect(readState().peer).toEqual({ preserved: true })
    })
  })
}
