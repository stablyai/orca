import { getProvider, registeredPtyProviders } from '../provider/registry'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../../shared/execution-host'

/** Probe the owning provider before opting into the no-process-table inventory projection. */
export async function supportsForegroundProcessEvidenceFromRuntimeController(
  hostId?: ExecutionHostId
): Promise<boolean> {
  if (hostId === LOCAL_EXECUTION_HOST_ID) {
    return true
  }
  if (hostId === undefined) {
    const supported = await Promise.all(
      registeredPtyProviders().map(async ({ provider, hostId: providerHostId }) =>
        providerHostId === LOCAL_EXECUTION_HOST_ID
          ? true
          : ((await provider.supportsForegroundProcessEvidence?.()) ?? false)
      )
    )
    return supported.every(Boolean)
  }
  try {
    return (await getProvider(hostId).supportsForegroundProcessEvidence?.()) ?? false
  } catch {
    return false
  }
}
