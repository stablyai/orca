/**
 * Proving the runtime behind a managed tunnel is this environment's orcad. A port held by another
 * runtime still accepts the connection, so a forward that opened proves nothing; only a status
 * call that completes the pairing handshake and reports the paired runtime id does.
 */
import { parsePairingCode, type PairingOffer } from '../../shared/pairing'
import { ORCAD_MANAGED_REMOTE_PORT } from '../../shared/orcad-managed-runtime'
import {
  isRecoverableRemoteRuntimeConnectionError,
  toRemoteRuntimeClientErrorLike
} from '../../shared/remote-runtime-client-error-classification'
import { RemoteRuntimeClientError } from '../../shared/remote-runtime-client-error'
import {
  getPreferredPairingOffer,
  type KnownRuntimeEnvironment
} from '../../shared/runtime-environments'
import { verifyRuntimePairingIdentity } from '../runtime/runtime-environment-identity-verification'
import type { ServeReadiness } from '../server/serve-readiness'
import { orcadBoundPort } from './orcad-managed-bound-port'
import { tunneledOrcadPairingCode } from './orcad-tunneled-pairing'

/** `unreachable` means nothing answered; it is never evidence about which server holds the port. */
export type OrcadTunnelIdentity =
  | { verdict: 'verified' }
  | { verdict: 'foreign' | 'unreachable'; detail: string }

export const ORCAD_IDENTITY_MISMATCH_CODE = 'orcad_identity_mismatch'

export class OrcadManagedIdentityError extends Error {
  readonly code = ORCAD_IDENTITY_MISMATCH_CODE
  constructor(remotePort: number, detail: string) {
    super(
      `${ORCAD_IDENTITY_MISMATCH_CODE}: the server on remote port ${remotePort} is not this ` +
        `managed Orca server (another Orca may be using that port): ${detail}`
    )
    this.name = 'OrcadManagedIdentityError'
  }
}

// Why 4001/4003: a runtime that rejects our keys closes the socket rather than replying.
const FOREIGN_CLOSE_CODES = new Set([4001, 4003])

export function classifyOrcadTunnelIdentityFailure(error: unknown): OrcadTunnelIdentity {
  const detail = error instanceof Error ? error.message : String(error)
  if (error instanceof RemoteRuntimeClientError && FOREIGN_CLOSE_CODES.has(error.closeCode ?? 0)) {
    return { verdict: 'foreign', detail }
  }
  return isRecoverableRemoteRuntimeConnectionError(toRemoteRuntimeClientErrorLike(error))
    ? { verdict: 'unreachable', detail }
    : { verdict: 'foreign', detail }
}

export async function verifyOrcadPairingIdentity(
  pairing: PairingOffer,
  expected: Pick<KnownRuntimeEnvironment, 'runtimeId' | 'pairedDeviceId'>
): Promise<OrcadTunnelIdentity> {
  try {
    await verifyRuntimePairingIdentity(pairing, expected)
    return { verdict: 'verified' }
  } catch (error) {
    return classifyOrcadTunnelIdentityFailure(error)
  }
}

/** Independent SSH access proved its identity when it linked; only managed orcad is checked. */
export function verifyManagedOrcadTunnelIdentity(
  environment: KnownRuntimeEnvironment
): Promise<OrcadTunnelIdentity> {
  if (!environment.orcadDeployment) {
    return Promise.resolve({ verdict: 'verified' })
  }
  // Why no runtime id: it is minted per process, so a restart by another desktop, or while this one
  // was away, changes it. The E2EE handshake with our pinned host key and our token being accepted
  // prove the server; the first authenticated status reply records the new id. Why no device id:
  // one left stale by a racing reply must not block it either.
  return verifyOrcadPairingIdentity(getPreferredPairingOffer(environment), { runtimeId: null })
}

/**
 * A fresh deploy has no saved environment yet: its pairing comes from the readiness, and a
 * foreign answer re-reads that readiness, whose bound endpoint the tunnel then follows.
 */
export function deployedOrcadTunnelChecks(
  initial: ServeReadiness,
  rereadReadiness: () => Promise<ServeReadiness>
) {
  let readiness = initial
  return {
    readiness: () => readiness,
    remotePort: orcadBoundPort(initial) ?? ORCAD_MANAGED_REMOTE_PORT,
    rereadRemotePort: async () => {
      readiness = await rereadReadiness()
      return orcadBoundPort(readiness) ?? ORCAD_MANAGED_REMOTE_PORT
    },
    verify: async (localPort: number): Promise<OrcadTunnelIdentity> => {
      const pairing = parsePairingCode(tunneledOrcadPairingCode(readiness, localPort))
      return pairing
        ? verifyOrcadPairingIdentity(pairing, { runtimeId: readiness.runtimeId || null })
        : { verdict: 'foreign', detail: 'The managed Orca server published an invalid pairing.' }
    }
  }
}
