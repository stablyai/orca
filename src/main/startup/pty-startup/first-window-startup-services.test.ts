import { describe, expect, it, vi } from 'vitest'
import {
  FIRST_WINDOW_STARTUP_SERVICE_TIMEOUT_MS,
  LOCAL_PTY_STARTUP_FAIL_OPEN_TIMEOUT_MS,
  startFirstWindowStartupServices
} from './first-window-startup-services'

describe('startFirstWindowStartupServices', () => {
  it('opens the provider gate when daemon startup finishes without waiting for hooks', async () => {
    let resolveDaemon!: () => void
    let resolveHooks!: () => void
    const startDaemonPtyProvider = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveDaemon = resolve
        })
    )
    const startAgentHookServer = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveHooks = resolve
        })
    )
    const started = startFirstWindowStartupServices({
      startDaemonPtyProvider,
      startAgentHookServer,
      onDaemonError: vi.fn(),
      onAgentHookServerError: vi.fn()
    })
    await Promise.resolve()
    expect(startDaemonPtyProvider).toHaveBeenCalledOnce()
    expect(startAgentHookServer).toHaveBeenCalledOnce()

    let allServicesReady = false
    let windowReady = false
    void started.localPtyReady.then(() => {
      allServicesReady = true
    })
    void started.firstWindowReady.then(() => {
      windowReady = true
    })
    resolveDaemon()
    await expect(started.localPtyProviderReady).resolves.toBeUndefined()
    expect(allServicesReady).toBe(false)
    expect(windowReady).toBe(false)

    resolveHooks()
    await Promise.all([started.localPtyReady, started.firstWindowReady])
  })

  it('opens the first window at the window timeout without aborting a slow daemon or opening the PTY gate', async () => {
    vi.useFakeTimers()
    const onDaemonError = vi.fn()
    let daemonSignal: AbortSignal | undefined
    let resolveDaemon!: () => void

    try {
      const started = startFirstWindowStartupServices({
        startDaemonPtyProvider: (signal) => {
          daemonSignal = signal
          return new Promise<void>((resolve) => {
            resolveDaemon = resolve
          })
        },
        startAgentHookServer: () => Promise.resolve(),
        onDaemonError,
        onAgentHookServerError: vi.fn()
      })

      let ptyGateOpened = false
      void started.localPtyReady.then(() => {
        ptyGateOpened = true
      })

      await vi.advanceTimersByTimeAsync(FIRST_WINDOW_STARTUP_SERVICE_TIMEOUT_MS)
      await expect(started.firstWindowReady).resolves.toBeUndefined()

      // Opening before daemon startup settles would create non-restorable fallback terminals (#5232).
      expect(ptyGateOpened).toBe(false)
      expect(daemonSignal?.aborted).toBe(false)
      expect(onDaemonError).not.toHaveBeenCalled()

      resolveDaemon()
      await expect(started.localPtyReady).resolves.toBeUndefined()
      await expect(started.localPtyProviderReady).resolves.toBeUndefined()
      expect(daemonSignal?.aborted).toBe(false)
      expect(onDaemonError).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails open the local PTY gate at the hard cap while aborting hung services', async () => {
    vi.useFakeTimers()
    const onDaemonError = vi.fn()
    const onAgentHookServerError = vi.fn()
    let daemonSignal: AbortSignal | undefined

    try {
      const started = startFirstWindowStartupServices({
        startDaemonPtyProvider: (signal) => {
          daemonSignal = signal
          return new Promise<void>(() => {})
        },
        startAgentHookServer: () => Promise.resolve(),
        onDaemonError,
        onAgentHookServerError
      })

      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(LOCAL_PTY_STARTUP_FAIL_OPEN_TIMEOUT_MS)
      await expect(started.firstWindowReady).resolves.toBeUndefined()
      await expect(started.localPtyReady).resolves.toBeUndefined()
      await expect(started.localPtyProviderReady).resolves.toBeUndefined()

      expect(onDaemonError).toHaveBeenCalledWith(expect.any(Error))
      expect(onAgentHookServerError).not.toHaveBeenCalled()
      expect(daemonSignal?.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
