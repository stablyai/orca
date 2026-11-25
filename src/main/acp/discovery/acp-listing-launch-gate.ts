import type { AcpLaunchGate } from '../launch/acp-launch-gate'
import type { ProviderAcquisitionConnection } from '../../provider-process/provider-acquisition-starts'
import { AgentModelCatalogListingStoppedError } from '../../native-chat/agent-model-catalog/agent-model-catalog-failures'

/** Sign-in, account-type changes and runtime removal stop a listing's server before they change
 *  its home, and refuse new listings while they run. */
export function enterAcpListingGate(
  gate: AcpLaunchGate | undefined,
  signal: AbortSignal | undefined
) {
  let entered: ReturnType<AcpLaunchGate['enter']> | undefined
  try {
    entered = gate?.enter(signal)
  } catch (error) {
    // Neither a refusal nor a stop says anything about the account, so the catalog must not cache them.
    throw new AgentModelCatalogListingStoppedError(String(error))
  }
  return {
    signal: entered?.signal ?? signal,
    retain: <C extends ProviderAcquisitionConnection>(connection: C): C => {
      gate?.retain(connection)
      return connection
    },
    stopped: (error: unknown): unknown =>
      entered?.signal.aborted && !signal?.aborted
        ? new AgentModelCatalogListingStoppedError(String(error))
        : error,
    leave: () => entered?.leave()
  }
}
