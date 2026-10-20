import { pairedRuntimeConnectionFromOffer } from '../../shared/paired-runtime-connection'
import { parsePairingCode, type PairingOffer } from '../../shared/pairing'
import type { ServeReadiness } from '../server/serve-readiness'
import {
  orcadIdentityRefusal,
  verifyOrcadPairingIdentity,
  type OrcadTunnelIdentity
} from '../managed-server/lifecycle/orcad-managed-tunnel-identity'
import { tunneledOrcadPairingCode } from '../ssh/orcad-tunneled-pairing'
import type { WslOrcadLaunch } from './wsl-orcad-deploy'

/** Reconnect with the enrolled grant and host key; startup offers only enroll new clients. */
export async function resolveWslOrcadPairing(
  launch: Extract<WslOrcadLaunch, { outcome: 'ready' }>,
  localPort: number,
  paired: PairingOffer | null,
  verifyIdentity = verifyWslOrcadIdentity
): Promise<string> {
  const pairingOffer = tunneledOrcadPairingCode(launch.readiness, localPort, paired)
  const identity = await verifyIdentity(pairingOffer, launch.readiness)
  if (identity.verdict === 'foreign' || identity.verdict === 'unpaired') {
    throw orcadIdentityRefusal(launch.port, identity)
  }
  if (identity.verdict === 'unreachable') {
    console.warn(
      `[wsl] Orca server in ${launch.distro} did not answer its bridge: ${identity.detail}`
    )
  }
  return pairingOffer
}

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
