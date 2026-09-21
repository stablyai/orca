import { getProvider, registeredPtyProviders } from '../provider/registry'

/** Probe the owning provider before opting into the no-process-table inventory projection. */
export async function supportsForegroundProcessEvidenceFromRuntimeController(
  connectionId?: string | null
): Promise<boolean> {
  if (connectionId === null) {
    return true
  }
  if (connectionId === undefined) {
    const providers = registeredPtyProviders()
    const supported = await Promise.all(
      providers.map(async ({ provider, connectionId: providerConnectionId }) =>
        providerConnectionId === null
          ? true
          : ((await provider.supportsForegroundProcessEvidence?.()) ?? false)
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
