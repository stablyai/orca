import { describe, expect, it, vi } from 'vitest'
import {
  flushOrcadProfileStoreForShutdown,
  installOrcadShutdownSignals,
  ORCAD_SHUTDOWN_DEADLINE_MS
} from './orcad-lifecycle'

describe('orcad profile-state shutdown', () => {
  it('keeps one bounded shutdown even when stop signals repeat', () => {
    vi.useFakeTimers()
    let signal: (() => void) | undefined
    vi.spyOn(process, 'on').mockImplementation((event, listener) => {
      if (event === 'SIGTERM') {
        signal = listener
      }
      return process
    })
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('shutdown deadline')
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const stop = vi.fn(() => new Promise<void>(() => {}))
    try {
      installOrcadShutdownSignals(stop)
      signal?.()
      signal?.()
      expect(stop).toHaveBeenCalledOnce()
      expect(exit).not.toHaveBeenCalled()
      expect(() => vi.advanceTimersByTime(ORCAD_SHUTDOWN_DEADLINE_MS)).toThrow('shutdown deadline')
      expect(exit).toHaveBeenCalledWith(1)
    } finally {
      vi.restoreAllMocks()
      vi.useRealTimers()
    }
  })

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

    expect(store.flushFinalOrThrowAsync).toHaveBeenCalledExactlyOnceWith()
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
