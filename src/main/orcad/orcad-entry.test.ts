import { describe, expect, it, vi } from 'vitest'
import { flushOrcadProfileStoreForShutdown } from './orcad-lifecycle'

describe('orcad profile-state shutdown', () => {
  it('flushes durably before closing the profile store', async () => {
    const events: string[] = []
    const store = {
      flushPendingOrThrowAsync: vi.fn(async () => {
        events.push('flush')
      }),
      freezeWrites: vi.fn(() => {
        events.push('freeze')
      })
    }

    await flushOrcadProfileStoreForShutdown(store)

    expect(store.flushPendingOrThrowAsync).toHaveBeenCalledOnce()
    expect(store.freezeWrites).toHaveBeenCalledOnce()
    expect(events).toEqual(['flush', 'freeze'])
  })

  it('closes the profile store even when the durable flush fails', async () => {
    const flushError = new Error('profile flush failed')
    const freezeWrites = vi.fn()
    const store = {
      flushPendingOrThrowAsync: vi.fn(async () => {
        throw flushError
      }),
      freezeWrites
    }

    await expect(flushOrcadProfileStoreForShutdown(store)).rejects.toBe(flushError)
    expect(freezeWrites).toHaveBeenCalledOnce()
  })
})
