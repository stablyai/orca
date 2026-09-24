import { describe, expect, it, vi } from 'vitest'
import { flushOrcadProfileStoreForShutdown } from './orcad-lifecycle'

describe('orcad profile-state shutdown', () => {
  it('flushes durably before closing the profile store', async () => {
    const events: string[] = []
    const store = {
      flushFinalOrThrowAsync: vi.fn(async () => {
        events.push('flush')
      }),
      freezeWritesAsync: vi.fn(async () => {
        events.push('freeze')
      })
    }

    await flushOrcadProfileStoreForShutdown(store)

    expect(store.flushFinalOrThrowAsync).toHaveBeenCalledOnce()
    expect(store.freezeWritesAsync).toHaveBeenCalledOnce()
    expect(events).toEqual(['flush', 'freeze'])
  })

  it('closes the profile store even when the durable flush fails', async () => {
    const flushError = new Error('profile flush failed')
    const freezeWritesAsync = vi.fn(async () => {})
    const store = {
      flushFinalOrThrowAsync: vi.fn(async () => {
        throw flushError
      }),
      freezeWritesAsync
    }

    await expect(flushOrcadProfileStoreForShutdown(store)).rejects.toBe(flushError)
    expect(freezeWritesAsync).toHaveBeenCalledOnce()
  })
})
