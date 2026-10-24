import { pairedRuntimeConnectionFromOffer } from '../../shared/paired-runtime-connection'
import { parsePairingCode, type PairingOffer } from '../../shared/pairing'
import type { ServeReadiness } from '../server/serve-readiness'
import {
  orcadIdentityRefusal,
  verifyOrcadPairingIdentity,
  type OrcadTunnelIdentity
} from '../managed-server/lifecycle/orcad-managed-tunnel-identity'
import { tunneledOrcadPairingCode } from '../ssh/orcad-tunneled-pairing'
import { getPreferredPairingOffer } from '../../shared/runtime-environments'
import {
  buildWithPairingRepair,
  type ManagedOrcadPairingRecovery
} from '../managed-server/lifecycle/orcad-managed-tunnel-pairing-recovery'
import type { WslOrcadLaunch } from './wsl-orcad-deploy'

/** The managed repair gate a refused enrolled token goes through, for one WSL host. */
export type WslOrcadPairingRecovery = Omit<ManagedOrcadPairingRecovery, 'ensure'> & {
  environmentId: string
}

/**
 * Reconnect with the enrolled grant and host key; startup offers only enroll new clients. A token
 * the host refuses re-pairs through the gate once, then must verify under the new pairing.
 */
export async function resolveWslOrcadPairing(
  launch: Extract<WslOrcadLaunch, { outcome: 'ready' }>,
  localPort: number,
  paired: PairingOffer | null,
  verifyIdentity = verifyWslOrcadIdentity,
  recovery?: WslOrcadPairingRecovery
): Promise<string> {
  const verified = (offer: PairingOffer | null) =>
    verifyWslOrcadPairing(launch, localPort, offer, verifyIdentity)
  // Why only an enrolled token: a first pairing has nothing to repair.
  if (!recovery || !paired) {
    return verified(paired)
  }
  let pairingOffer = ''
  await buildWithPairingRepair(
    {
      ...recovery,
      ensure: async (environment) => {
        pairingOffer = await verified(getPreferredPairingOffer(environment))
      }
    },
    recovery.environmentId,
    async () => {
      pairingOffer = await verified(paired)
    }
  )
  return pairingOffer
}

async function verifyWslOrcadPairing(
  launch: Extract<WslOrcadLaunch, { outcome: 'ready' }>,
  localPort: number,
  paired: PairingOffer | null,
  verifyIdentity: typeof verifyWslOrcadIdentity
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
