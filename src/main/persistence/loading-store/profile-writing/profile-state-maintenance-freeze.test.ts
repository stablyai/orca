import { expect, it, vi } from 'vitest'
import { fixture } from './profile-state-delayed-authority-fixture'

it('reports saving stopped when a failed maintenance pause freezes saving until restart', async () => {
  const { store, authority } = await fixture()
  const refused = new Error('database is locked')
  authority.close.mockRejectedValueOnce(refused)

  // A pending project move pauses without saving first, so any pause failure freezes saving.
  await expect(store.beginProfileMaintenance({ flush: false })).rejects.toBe(refused)

  expect(authority.reportSavingStopped).toHaveBeenCalledWith(refused)
  // Close for real here; the shared teardown would otherwise rethrow the failed pause.
  await store.freezeWritesAsync().catch(() => {})
  vi.spyOn(store, 'freezeWritesAsync').mockResolvedValue()
})
