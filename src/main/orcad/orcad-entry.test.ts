import { describe, expect, it, vi } from 'vitest'
import {
  flushOrcadProfileStoreForShutdown,
  installOrcadShutdownSignals,
  ORCAD_SHUTDOWN_DEADLINE_MS,
  startOrcadWithLifecycle
} from './orcad-lifecycle'

/** Installs the real signal handlers with process.exit captured instead of exiting. */
function captureShutdown() {
  vi.useFakeTimers()
  const signals = new Map<string, () => void>()
  vi.spyOn(process, 'on').mockImplementation((event, listener) => {
    signals.set(String(event), listener)
    return process
  })
  const exitCodes: (number | undefined)[] = []
  vi.spyOn(process, 'exit').mockImplementation((code) => {
    exitCodes.push(typeof code === 'number' ? code : undefined)
    throw new Error('process exit')
  })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  return { exitCodes, sigterm: () => signals.get('SIGTERM')?.() }
}

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
      const shutdown = installOrcadShutdownSignals(stop)
      signal?.()
      signal?.()
      expect(shutdown('idle')).toBe(false)
      expect(stop).toHaveBeenCalledOnce()
      expect(exit).not.toHaveBeenCalled()
      expect(() => vi.advanceTimersByTime(ORCAD_SHUTDOWN_DEADLINE_MS)).toThrow('shutdown deadline')
      expect(exit).toHaveBeenCalledWith(1)
    } finally {
      vi.restoreAllMocks()
      vi.useRealTimers()
    }
  })

  it('retracts a clean-stop record only when the stop fails', async () => {
    vi.spyOn(process, 'on').mockImplementation(() => process)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub only records the code; nothing after process.exit runs in these paths.
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const onFailed = vi.fn()
      installOrcadShutdownSignals(async () => {
        throw new Error('flush failed')
      })('idle', onFailed)
      await vi.waitFor(() => expect(exit).toHaveBeenCalled())
      expect(onFailed).toHaveBeenCalledOnce()

      const notFailed = vi.fn()
      installOrcadShutdownSignals(async () => {})('idle', notFailed)
      await vi.waitFor(() => expect(exit).toHaveBeenLastCalledWith(0))
      expect(notFailed).not.toHaveBeenCalled()
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('exits at the deadline while headless startup still waits on the writer', async () => {
    const { exitCodes, sigterm } = captureShutdown()
    const releaseAdmission = vi.fn()
    try {
      // Writer initialization never acknowledges, so startup never returns a handle.
      const startup = startOrcadWithLifecycle(
        () => new Promise<object>(() => {}),
        async (runtimeCleanupSucceeded) => {
          if (runtimeCleanupSucceeded) {
            releaseAdmission()
          }
        }
      )
      installOrcadShutdownSignals(async () => (await startup).stop())
      sigterm()
      await vi.advanceTimersByTimeAsync(ORCAD_SHUTDOWN_DEADLINE_MS - 1)
      expect(exitCodes).toEqual([])
      await expect(vi.advanceTimersByTimeAsync(1)).rejects.toThrow('process exit')
      expect(exitCodes).toEqual([1])
      expect(releaseAdmission).not.toHaveBeenCalled()
    } finally {
      vi.restoreAllMocks()
      vi.useRealTimers()
    }
  })

  it('exits at the deadline without claiming success or releasing admission while a flush is pending', async () => {
    const { exitCodes, sigterm } = captureShutdown()
    const releaseAdmission = vi.fn()
    const store = {
      flushFinalOrThrowAsync: vi.fn(() => new Promise<void>(() => {})),
      freezeWritesAsync: vi.fn(async () => {})
    }
    try {
      const startup = startOrcadWithLifecycle(
        async (registerCleanup) => {
          registerCleanup(() => flushOrcadProfileStoreForShutdown(store))
          return {}
        },
        async (runtimeCleanupSucceeded) => {
          if (runtimeCleanupSucceeded) {
            releaseAdmission()
          }
        }
      )
      await startup
      installOrcadShutdownSignals(async () => (await startup).stop())
      sigterm()
      await expect(vi.advanceTimersByTimeAsync(ORCAD_SHUTDOWN_DEADLINE_MS)).rejects.toThrow(
        'process exit'
      )
      expect(store.flushFinalOrThrowAsync).toHaveBeenCalledOnce()
      expect(exitCodes).toEqual([1])
      expect(store.freezeWritesAsync).not.toHaveBeenCalled()
      expect(releaseAdmission).not.toHaveBeenCalled()
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
