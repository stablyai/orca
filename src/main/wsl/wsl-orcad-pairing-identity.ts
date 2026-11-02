import { pairedRuntimeConnectionFromOffer } from '../../shared/paired-runtime-connection'
import { parsePairingCode } from '../../shared/pairing'
import type { ServeReadiness } from '../server/serve-readiness'
import {
  verifyOrcadPairingIdentity,
  type OrcadTunnelIdentity
} from '../managed-server/lifecycle/orcad-managed-tunnel-identity'

/** Whether the server behind a WSL bridge is the orcad that published `readiness`. */
export async function verifyWslOrcadIdentity(
  pairingOffer: string,
  readiness: ServeReadiness
): Promise<OrcadTunnelIdentity> {
  const offer = parsePairingCode(pairingOffer)
  return offer
    ? verifyOrcadPairingIdentity(pairedRuntimeConnectionFromOffer(offer), {
        runtimeId: readiness.runtimeId || null
      })
    : { verdict: 'foreign', detail: 'The Orca server in WSL published an invalid pairing offer.' }
}
