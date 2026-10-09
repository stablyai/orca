import { getProvider, registeredPtyProviders } from '../provider/registry'
import {
  getConnectionExecutionHostId,
  LOCAL_EXECUTION_HOST_ID
} from '../../../../shared/execution-host'

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
      providers.map(async ({ provider, hostId }) =>
        hostId === LOCAL_EXECUTION_HOST_ID
          ? true
          : ((await provider.supportsForegroundProcessEvidence?.()) ?? false)
      )
    )
    return supported.every(Boolean)
  }
  try {
    return (
      (await getProvider(
        getConnectionExecutionHostId(connectionId)
      ).supportsForegroundProcessEvidence?.()) ?? false
    )
  } catch {
    return false
  }
}
