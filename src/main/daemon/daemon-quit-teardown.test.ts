import { describe, expect, it, vi } from 'vitest'
import {
  resolveDaemonQuitMode,
  runGracefulDaemonShutdownWithFallback,
  shutdownAdoptedDaemonGenerations
} from './daemon-quit-teardown'

describe('resolveDaemonQuitMode', () => {
  const ordinaryQuit = {
    updateQuitInProgress: false,
    relaunchRequested: false,
    devParentShutdownRequested: false
  }

  it('shuts down daemons for an ordinary Windows quit', () => {
    expect(resolveDaemonQuitMode({ ...ordinaryQuit, platform: 'win32' })).toBe('shutdown')
  })

  it('preserves warm reattach for Windows updates and intentional relaunches', () => {
    expect(
      resolveDaemonQuitMode({ ...ordinaryQuit, platform: 'win32', updateQuitInProgress: true })
    ).toBe('disconnect')
    expect(
      resolveDaemonQuitMode({ ...ordinaryQuit, platform: 'win32', relaunchRequested: true })
    ).toBe('disconnect')
  })

  it('keeps normal macOS and Linux quit behavior unchanged', () => {
    expect(resolveDaemonQuitMode({ ...ordinaryQuit, platform: 'darwin' })).toBe('disconnect')
    expect(resolveDaemonQuitMode({ ...ordinaryQuit, platform: 'linux' })).toBe('disconnect')
  })

  it('shuts down an ownerless dev daemon on every platform', () => {
    expect(
      resolveDaemonQuitMode({
        ...ordinaryQuit,
        platform: 'darwin',
        updateQuitInProgress: true,
        relaunchRequested: true,
        devParentShutdownRequested: true
      })
    ).toBe('shutdown')
  })
})

describe('shutdownAdoptedDaemonGenerations', () => {
  it('shuts down current and each discovered legacy generation once', async () => {
    const shutdownCurrent = vi.fn(async () => {})
    const shutdownLegacy = vi.fn(async () => {})

    await shutdownAdoptedDaemonGenerations({
      shutdownCurrent,
      legacyProtocolVersions: [21, 22, 21],
      shutdownLegacy
    })

    expect(shutdownCurrent).toHaveBeenCalledOnce()
    expect(shutdownLegacy.mock.calls).toEqual([[21], [22]])
  })

  it('attempts every generation before reporting failures', async () => {
    const shutdownCurrent = vi.fn(async () => {
      throw new Error('current failed')
    })
    const shutdownLegacy = vi.fn(async (protocolVersion: number) => {
      if (protocolVersion === 21) {
        throw new Error('legacy failed')
      }
    })

    await expect(
      shutdownAdoptedDaemonGenerations({
        shutdownCurrent,
        legacyProtocolVersions: [21, 22],
        shutdownLegacy
      })
    ).rejects.toThrow('Daemon generation shutdown failed')
    expect(shutdownLegacy.mock.calls).toEqual([[21], [22]])
  })
})

describe('runGracefulDaemonShutdownWithFallback', () => {
  it('starts the fallback on schedule when graceful RPC stalls', async () => {
    vi.useFakeTimers()
    let finishGraceful!: () => void
    const graceful = vi.fn(() => new Promise<void>((resolve) => (finishGraceful = resolve)))
    const fallback = vi.fn(async () => {})
    const shutdown = runGracefulDaemonShutdownWithFallback({
      graceful,
      fallback,
      fallbackDelayMs: 8_000
    })

    await vi.advanceTimersByTimeAsync(7_999)
    expect(fallback).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(fallback).toHaveBeenCalledOnce()
    finishGraceful()
    await shutdown
    vi.useRealTimers()
  })

  it('cancels the fallback after graceful shutdown succeeds', async () => {
    vi.useFakeTimers()
    const fallback = vi.fn(async () => {})

    await runGracefulDaemonShutdownWithFallback({
      graceful: async () => {},
      fallback,
      fallbackDelayMs: 8_000
    })
    await vi.runAllTimersAsync()

    expect(fallback).not.toHaveBeenCalled()
    vi.useRealTimers()
  })
})
