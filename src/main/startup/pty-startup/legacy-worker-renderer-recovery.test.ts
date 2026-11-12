import { describe, expect, it, vi } from 'vitest'
import { recoverLegacyWorkerTerminalsForRendererStartup } from './legacy-worker-renderer-recovery'

describe('legacy worker renderer recovery', () => {
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
})
