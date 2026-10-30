import { describe, expect, it, vi } from 'vitest'
import { recoverLegacyWorkerTerminalsForRendererStartup } from './legacy-worker-renderer-recovery'
import {
  FIRST_WINDOW_STARTUP_SERVICE_TIMEOUT_MS,
  LOCAL_PTY_STARTUP_FAIL_OPEN_TIMEOUT_MS,
  startFirstWindowStartupServices
} from './first-window-startup-services'

describe('legacy worker renderer recovery', () => {
  it('waits for daemon adoption before renderer recovery can continue', async () => {
    let resolveFirstWindow!: () => void
    let resolveWslBarrier!: () => void
    let resolveProvider!: () => void
    const firstWindowReady = new Promise<void>((resolve) => {
      resolveFirstWindow = resolve
    })
    const wslBarrierReady = new Promise<void>((resolve) => {
      resolveWslBarrier = resolve
    })
    const providerReady = new Promise<void>((resolve) => {
      resolveProvider = resolve
    })
    const reconcile = vi.fn().mockResolvedValue(undefined)
    const startup = recoverLegacyWorkerTerminalsForRendererStartup({
      firstWindowStartupServicesReady: firstWindowReady,
      managedWslCliStartupBarrierReady: wslBarrierReady,
      localPtyProviderStartupReady: providerReady,
      reconcile,
      onDeferredRecoveryError: vi.fn()
    })

    resolveFirstWindow()
    await Promise.resolve()
    expect(reconcile).not.toHaveBeenCalled()

    resolveWslBarrier()
    await Promise.resolve()
    expect(reconcile).not.toHaveBeenCalled()

    resolveProvider()
    await startup
    expect(reconcile).toHaveBeenCalledOnce()
  })

  it('recovers once when the provider is already ready', async () => {
    const reconcile = vi.fn().mockResolvedValue(undefined)

    await recoverLegacyWorkerTerminalsForRendererStartup({
      firstWindowStartupServicesReady: Promise.resolve(),
      managedWslCliStartupBarrierReady: Promise.resolve(),
      localPtyProviderStartupReady: Promise.resolve(),
      reconcile,
      onDeferredRecoveryError: vi.fn()
    })

    expect(reconcile).toHaveBeenCalledOnce()
  })

  it('contains provider startup rejection after initial recovery', async () => {
    const providerError = new Error('provider failed')
    const reconcile = vi.fn().mockResolvedValue(undefined)
    let reportError!: (error: unknown) => void
    const reportedError = new Promise<unknown>((resolve) => {
      reportError = resolve
    })

    await recoverLegacyWorkerTerminalsForRendererStartup({
      firstWindowStartupServicesReady: Promise.resolve(),
      managedWslCliStartupBarrierReady: Promise.resolve(),
      localPtyProviderStartupReady: Promise.reject(providerError),
      reconcile,
      onDeferredRecoveryError: reportError
    })

    await expect(reportedError).resolves.toBe(providerError)
    expect(reconcile).not.toHaveBeenCalled()
  })

  it('contains recovery rejection', async () => {
    const recoveryError = new Error('recovery failed')
    const reconcile = vi.fn().mockRejectedValueOnce(recoveryError)
    let reportError!: (error: unknown) => void
    const reportedError = new Promise<unknown>((resolve) => {
      reportError = resolve
    })

    await recoverLegacyWorkerTerminalsForRendererStartup({
      firstWindowStartupServicesReady: Promise.resolve(),
      managedWslCliStartupBarrierReady: Promise.resolve(),
      localPtyProviderStartupReady: Promise.resolve(),
      reconcile,
      onDeferredRecoveryError: reportError
    })

    await expect(reportedError).resolves.toBe(recoveryError)
    expect(reconcile).toHaveBeenCalledOnce()
  })

  it('fails open at the hard cap without allowing a premature recovery', async () => {
    vi.useFakeTimers()
    let daemonSignal: AbortSignal | undefined
    try {
      const services = startFirstWindowStartupServices({
        startDaemonPtyProvider: (signal) => {
          daemonSignal = signal
          return new Promise<void>(() => {})
        },
        startAgentHookServer: () => Promise.resolve(),
        onDaemonError: vi.fn(),
        onAgentHookServerError: vi.fn()
      })
      const reconcile = vi.fn().mockResolvedValue(undefined)
      const startup = recoverLegacyWorkerTerminalsForRendererStartup({
        firstWindowStartupServicesReady: services.firstWindowReady,
        managedWslCliStartupBarrierReady: Promise.resolve(),
        localPtyProviderStartupReady: services.localPtyProviderReady,
        reconcile,
        onDeferredRecoveryError: vi.fn()
      })

      await vi.advanceTimersByTimeAsync(FIRST_WINDOW_STARTUP_SERVICE_TIMEOUT_MS)
      expect(reconcile).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(
        LOCAL_PTY_STARTUP_FAIL_OPEN_TIMEOUT_MS - FIRST_WINDOW_STARTUP_SERVICE_TIMEOUT_MS
      )
      await startup
      expect(reconcile).toHaveBeenCalledOnce()
      expect(daemonSignal?.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
