// Open forwards prove no identity; require an authenticated status call from the pinned server.
import { parsePairingCode } from '../../../shared/remote-runtime/pairing/pairing'
import {
  pairedRuntimeConnectionFromOffer,
  type PairedRuntimeConnection
} from '../../../shared/remote-runtime/pairing/paired-runtime-connection'
import { ORCAD_MANAGED_REMOTE_PORT } from '../../../shared/orcad-managed-runtime'
import {
  isRecoverableRemoteRuntimeConnectionError,
  toRemoteRuntimeClientErrorLike
} from '../../../shared/remote-runtime/remote-runtime-client-error-classification'
import { RemoteRuntimeClientError } from '../../../shared/remote-runtime/remote-runtime-client-error'
import {
  getPreferredPairedRuntimeConnection,
  type KnownRuntimeEnvironment
} from '../../../shared/remote-runtime/host-catalog/runtime-environments'
import { verifyRuntimePairingIdentity } from '../../runtime/hosts/identity/runtime-environment-identity-verification'
import type { ServeReadiness } from '../../server/serve-readiness'
import { orcadBoundPort } from './orcad-managed-bound-port'
import { tunneledOrcadPairingCode } from '../../ssh/orcad-tunneled-pairing'
import { OrcadManagedPairingRepairFailedError } from './orcad-managed-pairing-repair-failure'
import { quotePosixShellUnlessPlain } from '../../../shared/shell/launch/shell-argument-quoting'
import { RUNTIME_SERVER_REPLACED_STATUS_CODE } from '../../../shared/remote-runtime/host-status/runtime-host-status'

/** Unreachable proves no identity; unpaired is a refusal sealed by the pinned server key. */
export type OrcadTunnelIdentity =
  | { verdict: 'verified' }
  | { verdict: 'foreign' | 'unreachable' | 'unpaired'; detail: string }

export const ORCAD_IDENTITY_MISMATCH_CODE = 'orcad_identity_mismatch'

/** `foreign-port`: another process answered; `replaced-server`: the host's own slot serves another key. */
export type OrcadIdentityMismatchKind = 'foreign-port' | 'replaced-server'

export class OrcadManagedIdentityError extends Error {
  readonly code = ORCAD_IDENTITY_MISMATCH_CODE
  private constructor(
    readonly kind: OrcadIdentityMismatchKind,
    explanation: string,
    detail: string
  ) {
    super(`${ORCAD_IDENTITY_MISMATCH_CODE}: ${explanation}: ${detail}`)
    this.name = 'OrcadManagedIdentityError'
  }

  static foreignPort(remotePort: number, detail: string): OrcadManagedIdentityError {
    return new OrcadManagedIdentityError(
      'foreign-port',
      `the server on remote port ${remotePort} is not this host’s Orca server ` +
        '(another Orca may be using that port)',
      detail
    )
  }

  /** SSH access alone can't re-pin a different server key, so only the user can re-pair. */
  static replacedServer(
    environment: { id: string; name: string },
    detail: string
  ): OrcadManagedIdentityError {
    const environmentName = environment.name
    // Why the id: a name is free text, so pasting it into a shell could expand or pick another server.
    const selector = quotePosixShellUnlessPlain(environment.id)
    return new OrcadManagedIdentityError(
      'replaced-server',
      `${environmentName} is not the Orca server this desktop paired with (Orca now connects ` +
        'to the host as a different SSH user, or the server was reinstalled), so reconnecting ' +
        `won’t restore access. To pair with the host’s current server, open the ⋯ menu on ` +
        `${environmentName} in Settings › Remote Orca Servers and choose Forget… (or run ` +
        `\`orca environment forget --environment ${selector} --yes\`), then click ` +
        'Connect on the SSH host',
      detail
    )
  }
}

/** Status code of a refusal automatic retries can't clear (the pairing must change); null otherwise. */
export function managedOrcadRefusalNeedingUserCode(error: unknown): string | null {
  if (error instanceof OrcadManagedIdentityError && error.kind === 'replaced-server') {
    return RUNTIME_SERVER_REPLACED_STATUS_CODE
  }
  return error instanceof OrcadManagedPairingRepairFailedError ? 'unauthorized' : null
}

export const ORCAD_PAIRING_REJECTED_CODE = 'orcad_pairing_rejected'

export class OrcadManagedPairingRejectedError extends Error {
  readonly code = ORCAD_PAIRING_REJECTED_CODE
  constructor(detail: string) {
    super(
      `${ORCAD_PAIRING_REJECTED_CODE}: this host’s Orca server no longer accepts ` +
        `this desktop's pairing (its saved devices were reset, or this desktop was removed ` +
        `there), so reconnecting alone won't restore access: ${detail}`
    )
    this.name = 'OrcadManagedPairingRejectedError'
  }
}

export function orcadIdentityRefusal(
  remotePort: number,
  identity: Exclude<OrcadTunnelIdentity, { verdict: 'verified' }>
): Error {
  return identity.verdict === 'unpaired'
    ? new OrcadManagedPairingRejectedError(identity.detail)
    : OrcadManagedIdentityError.foreignPort(remotePort, identity.detail)
}

// Key rejection closes the socket instead of returning a status reply.
const FOREIGN_CLOSE_CODES = new Set([4001, 4003])

export function classifyOrcadTunnelIdentityFailure(error: unknown): OrcadTunnelIdentity {
  const detail = error instanceof Error ? error.message : String(error)
  // Only sealed access-grant refusals prove the pinned server answered.
  if (
    error instanceof RemoteRuntimeClientError &&
    error.code === 'unauthorized' &&
    error.pairingStage === 'access-grant'
  ) {
    return { verdict: 'unpaired', detail }
  }
  if (error instanceof RemoteRuntimeClientError && FOREIGN_CLOSE_CODES.has(error.closeCode ?? 0)) {
    return { verdict: 'foreign', detail }
  }
  return isRecoverableRemoteRuntimeConnectionError(toRemoteRuntimeClientErrorLike(error))
    ? { verdict: 'unreachable', detail }
    : { verdict: 'foreign', detail }
}

export async function verifyOrcadPairingIdentity(
  connection: PairedRuntimeConnection,
  expected: Pick<KnownRuntimeEnvironment, 'runtimeId' | 'pairedDeviceId'>
): Promise<OrcadTunnelIdentity> {
  try {
    await verifyRuntimePairingIdentity(connection, expected)
    return { verdict: 'verified' }
  } catch (error) {
    return classifyOrcadTunnelIdentityFailure(error)
  }
}

export function verifyManagedOrcadTunnelIdentity(
  environment: KnownRuntimeEnvironment
): Promise<OrcadTunnelIdentity> {
  if (!environment.orcadDeployment) {
    return Promise.resolve({ verdict: 'verified' })
  }
  // Runtime/device IDs can change or become stale; pinned-key handshake and token acceptance prove identity.
  return verifyOrcadPairingIdentity(getPreferredPairedRuntimeConnection(environment), {
    runtimeId: null
  })
}

/** Fresh deploys have no saved pairing; reread readiness after foreign answers to follow port changes. */
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
        ? verifyOrcadPairingIdentity(pairedRuntimeConnectionFromOffer(pairing), {
            runtimeId: readiness.runtimeId || null
          })
        : { verdict: 'foreign', detail: 'This host’s Orca server published an invalid pairing.' }
    }
  }
}
