import type { ServeReadiness } from '../server/serve-readiness'
import type { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'
import { buildServePairingReadiness } from '../server/serve-pairing-readiness'
import type { OrcadHealth } from './orcad-health'
import type { OrcadOptions } from './orcad-start-contract'

export async function buildOrcadServeReadiness(input: {
  options: OrcadOptions
  runtimeId: string
  rpc: Pick<OrcaRuntimeRpcServer, 'getWebSocketEndpoint' | 'createPairingOffer'>
  collectHealth: () => Promise<OrcadHealth>
}): Promise<ServeReadiness> {
  return {
    runtimeId: input.runtimeId,
    ...(await buildServePairingReadiness(input.options, input.rpc)),
    // WSL CLI reconciliation runs only in desktop launch, so no repair is pending here.
    managedWslCliReconciliation: 'settled',
    // Deployers inspect readiness health to reject hosts whose terminal daemon is unavailable.
    health: await input.collectHealth()
  }
}
