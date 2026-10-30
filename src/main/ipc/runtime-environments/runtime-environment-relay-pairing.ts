import { pairedRuntimeConnectionFromOffer } from '../../../shared/paired-runtime-connection'
import type { PairingOffer } from '../../../shared/pairing'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import type { RuntimeRelayConnection } from '../../../shared/runtime-relay-connection'
import { runtimeRelayPairingAttempt } from '../../../shared/runtime-relay-pairing-attempt'
import { DeviceCredentialInstalledSchema } from '../../../shared/mobile-relay-credential-contract'
import { RemoteRuntimeClientError } from '../../../shared/remote-runtime/remote-runtime-client-error'
import {
  sendRemoteRuntimeRequest,
  sendRemoteRuntimeRequestWithStatusPreflight
} from '../../../shared/remote-runtime/remote-runtime-client'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../../shared/electron-remote-runtime-client-capabilities'
import {
  verifyRemotePairingRuntimeStatus,
  type RemotePairingFailure
} from '../../../shared/remote-pairing-verification'

export async function verifyRuntimeRelayPairing(
  userDataPath: string,
  offer: PairingOffer
): Promise<
  | {
      ok: true
      runtimeStatus: RuntimeStatus
      relayConnection: RuntimeRelayConnection
      finishPairing: () => void
    }
  | RemotePairingFailure
> {
  const connection = pairedRuntimeConnectionFromOffer(offer)
  if (!connection.relayConnection) {
    throw new Error('Expected Relay pairing details')
  }
  const attempt = runtimeRelayPairingAttempt(userDataPath, offer)
  const resume: RuntimeRelayConnection = {
    ...connection.relayConnection,
    credential: attempt.resumeToken,
    credentialKind: 'resume'
  }
  if (attempt.recovered) {
    try {
      const status = await sendRemoteRuntimeRequest<RuntimeStatus>(
        { ...connection, relayConnection: resume },
        'status.get',
        undefined,
        15_000,
        undefined,
        undefined,
        ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
      )
      const verified = status.ok ? verifyRemotePairingRuntimeStatus(status.result) : null
      if (verified?.ok) {
        return {
          ok: true,
          runtimeStatus: verified.runtimeStatus,
          relayConnection: resume,
          finishPairing: attempt.finish
        }
      }
      if (verified) {
        return verified
      }
    } catch (error) {
      if (!(error instanceof RemoteRuntimeClientError) || error.code !== 'unauthorized') {
        throw error
      }
    }
  }
  let runtimeStatus: RuntimeStatus | undefined
  const installed = await sendRemoteRuntimeRequestWithStatusPreflight<unknown>(
    connection,
    'pairing.provisionRelay',
    { reqId: attempt.reqId, newResumeTokenHash: attempt.tokenHash },
    30_000,
    (status) => {
      const verification = status.ok ? verifyRemotePairingRuntimeStatus(status.result) : null
      if (!verification?.ok) {
        throw new Error(verification?.message ?? 'Could not verify the Relay host.')
      }
      runtimeStatus = verification.runtimeStatus
    },
    undefined,
    ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
  )
  if (!installed.ok) {
    return { ok: false, kind: 'connection-interrupted', message: installed.error.message }
  }
  const receipt = DeviceCredentialInstalledSchema.parse(installed.result)
  if (
    !runtimeStatus ||
    receipt.reqId !== attempt.reqId ||
    receipt.authorizationMode !== 'relay-basis'
  ) {
    throw new Error('Relay credential installation did not match this pairing attempt.')
  }
  return {
    ok: true,
    runtimeStatus,
    relayConnection: resume,
    finishPairing: attempt.finish
  }
}
