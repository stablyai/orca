import type { ServeReadiness } from '../server/serve-readiness'
import type { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'
import { buildServePairingReadiness } from '../server/serve-pairing-readiness'
import type { OrcadHealth } from './orcad-health'
import type { OrcadOptions } from './orcad-entry'

/** The readiness payload orcad publishes once its RPC transport is listening. */
export async function buildOrcadServeReadiness(input: {
  options: OrcadOptions
  runtimeId: string
  rpc: Pick<OrcaRuntimeRpcServer, 'getWebSocketEndpoint' | 'createPairingOffer'>
  collectHealth: () => Promise<OrcadHealth>
}): Promise<ServeReadiness> {
  return {
    runtimeId: input.runtimeId,
    ...(await buildServePairingReadiness(input.options, input.rpc)),
    // Why 'settled': the WSL CLI reconciliation barrier is a desktop-launch concern.
    // orcad never runs it, so there is no pending repair a client could race.
    managedWslCliReconciliation: 'settled',
    // Why in the readiness payload: this is the one message a supervisor and a deploy
    // transaction both read, and a green orcad with a dead daemon is exactly the
    // looks-healthy-but-useless state they must not activate.
    health: await input.collectHealth()
  }
}
