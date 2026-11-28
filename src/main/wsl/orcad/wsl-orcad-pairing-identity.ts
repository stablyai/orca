import { pairedRuntimeConnectionFromOffer } from '../../../shared/remote-runtime/pairing/paired-runtime-connection'
import { parsePairingCode } from '../../../shared/remote-runtime/pairing/pairing'
import type { PairingOffer } from '../../../shared/remote-runtime/pairing/mobile-relay-pairing-offer'
import type { ServeReadiness } from '../../server/serve-readiness'
import {
  OrcadManagedIdentityError,
  orcadIdentityRefusal,
  verifyOrcadPairingIdentity,
  type OrcadTunnelIdentity
} from '../../managed-server/lifecycle/orcad-managed-tunnel-identity'
import { tunneledOrcadPairingCode } from '../../managed-server/lifecycle/orcad-tunneled-pairing'
import { getPreferredPairingOffer } from '../../../shared/remote-runtime/host-catalog/runtime-environments'
import {
  buildWithPairingRepair,
  type ManagedOrcadPairingRecovery
} from '../../managed-server/lifecycle/orcad-managed-tunnel-pairing-recovery'
import type { WslOrcadLaunch } from './wsl-orcad-launch-contract'

/** The managed repair gate a refused enrolled token goes through, for one WSL host. */
export type WslOrcadPairingRecovery = Omit<ManagedOrcadPairingRecovery, 'ensure'> & {
  environmentId: string
}

/** Reconnect with enrolled token/pinned host key. Repair refusal once through the gate and verify the replacement; startup offers are for enrollment only. */
export async function resolveWslOrcadPairing(
  launch: Extract<WslOrcadLaunch, { outcome: 'ready' }>,
  localPort: number,
  paired: PairingOffer | null,
  verifyIdentity = verifyWslOrcadIdentity,
  recovery?: WslOrcadPairingRecovery
): Promise<string> {
  const verified = (offer: PairingOffer | null) =>
    verifyWslOrcadPairing(launch, localPort, offer, verifyIdentity)
  // First-time pairing has no enrolled token to repair.
  if (!recovery || !paired) {
    return verified(paired)
  }
  let pairingOffer = ''
  await withWslIdentityWording(launch.distro, () =>
    buildWithPairingRepair(
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
  )
  return pairingOffer
}

/** An enrolled WSL host's proven refusal names WSL causes and fixes (#49180); a guess stays as it was. */
async function withWslIdentityWording(distro: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run()
  } catch (error) {
    const proven =
      error instanceof OrcadManagedIdentityError &&
      (error.sealed || error.kind === 'replaced-server')
    throw proven ? OrcadManagedIdentityError.wslHostServer(distro, error) : error
  }
}

async function verifyWslOrcadPairing(
  launch: Extract<WslOrcadLaunch, { outcome: 'ready' }>,
  localPort: number,
  paired: PairingOffer | null,
  verifyIdentity: typeof verifyWslOrcadIdentity
): Promise<string> {
  const pairingOffer = tunneledOrcadPairingCode(launch.readiness, localPort, paired)
  const identity = await verifyIdentity(pairingOffer, launch.readiness)
  // A reset, not a restart: the account's key differed before launch and the server serves another.
  if (identity.verdict === 'foreign' && launch.pairedKeyChanged && servesOtherKey(launch, paired)) {
    throw OrcadManagedIdentityError.wslHostKeyChanged(launch.distro, identity.detail)
  }
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

/** False only when the server's own startup offer names the paired key; unknown counts as other. */
function servesOtherKey(
  launch: Extract<WslOrcadLaunch, { outcome: 'ready' }>,
  paired: PairingOffer | null
): boolean {
  const { pairing } = launch.readiness
  const served = pairing.available ? parsePairingCode(pairing.url)?.publicKeyB64 : undefined
  return !served || served !== paired?.publicKeyB64
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
