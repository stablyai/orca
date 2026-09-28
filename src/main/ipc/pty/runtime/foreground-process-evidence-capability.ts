import { getProvider, registeredPtyProviders, localProvider } from '../provider/registry'

/** Probe the owning provider before opting into the no-process-table inventory projection. */
export async function supportsForegroundProcessEvidenceFromRuntimeController(
  connectionId?: string | null
): Promise<boolean> {
  if (connectionId === undefined || connectionId === null) {
    const providers = registeredPtyProviders().filter(
      (entry) => connectionId === undefined || entry.connectionId === null
    )
    const supported = await Promise.all(
      providers.map(async ({ provider }) =>
        provider === localProvider
          ? true
          : ((await Promise.resolve()
              .then(() => provider.supportsForegroundProcessEvidence?.())
              .catch(() => false)) ?? false)
      )
    )
    return supported.every(Boolean)
  }
  try {
    return (await getProvider(connectionId).supportsForegroundProcessEvidence?.()) ?? false
  } catch {
    return false
  }
}
