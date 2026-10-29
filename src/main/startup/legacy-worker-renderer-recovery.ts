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
  const [providerResult] = await Promise.all([
    providerStartupResult,
    options.firstWindowStartupServicesReady,
    options.managedWslCliStartupBarrierReady
  ])
  if (!providerResult.ok) {
    options.onDeferredRecoveryError(providerResult.error)
    return
  }
  try {
    await options.reconcile()
  } catch (error) {
    options.onDeferredRecoveryError(error)
  }
}
