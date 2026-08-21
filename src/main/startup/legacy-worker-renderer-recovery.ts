type LegacyWorkerRendererRecoveryOptions = {
  firstWindowStartupServicesReady: Promise<void>
  managedWslCliStartupBarrierReady: Promise<void>
  localPtyProviderStartupReady: Promise<void>
  reconcile: () => Promise<unknown> | undefined
  onDeferredRecoveryError: (error: unknown) => void
}

export async function recoverLegacyWorkerTerminalsForRendererStartup(
  options: LegacyWorkerRendererRecoveryOptions
): Promise<void> {
  const providerStartupResult = options.localPtyProviderStartupReady.then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error })
  )
  await Promise.all([
    options.firstWindowStartupServicesReady,
    options.managedWslCliStartupBarrierReady
  ])
  void providerStartupResult
    .then(async (result) => {
      if (!result.ok) {
        throw result.error
      }
      await options.reconcile()
    })
    .catch(options.onDeferredRecoveryError)
  try {
    await options.reconcile()
  } catch (error) {
    options.onDeferredRecoveryError(error)
  }
}
