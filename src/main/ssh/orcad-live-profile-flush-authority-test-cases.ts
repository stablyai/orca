import { expect, it, vi } from 'vitest'
import type { preparedEntryFixture } from '../persistence-orcad-live-retirement-installation.test'
import { createStore } from '../persistence-test-harness'
import { targetLifecycleInFlight } from '../ipc/ssh-target-lifecycle-queue'

export function registerLiveProfileFlushAuthorityTests(fixture: typeof preparedEntryFixture) {
  it.each(['provider', 'inventory'])(
    'refuses acknowledgment when %s changes during the installed-profile flush',
    async (changed) => {
      const f = await fixture()
      const flush = f.store.flushPendingOrThrowAsync.bind(f.store)
      vi.spyOn(f.store, 'flushPendingOrThrowAsync').mockImplementation(async (options) => {
        await flush(options)
        if (f.store.listOrcadLiveRetirementMarkers().length > 0) {
          if (changed === 'provider') {
            f.provider.providerGeneration++
          } else {
            f.assertInventory.mockImplementation(() => {
              throw new Error('runtime inventory changed')
            })
          }
        }
      })
      await expect(f.run()).rejects.toThrow(
        changed === 'provider' ? 'source_authority_changed' : 'runtime inventory changed'
      )
      expect(createStore().inspectOrcadLiveRetirementProfileState(f.record).state).toBe(
        'profile-installed'
      )
      expect(f.provider.requestHostRpc).not.toHaveBeenCalled()
      expect(targetLifecycleInFlight.has(f.target.id)).toBe(false)
    }
  )
}
