import {
  getPreferredPairingOffer,
  type KnownRuntimeEnvironment
} from '../../shared/runtime-environments'
import { sendRemoteRuntimeRequest } from '../../shared/remote-runtime-client'
import { verifyRemotePairingRuntimeStatus } from '../../shared/remote-pairing-verification'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../shared/protocol-version'
import type { RuntimeStatus } from '../../shared/runtime-types'

export async function verifyRuntimeEnvironmentIdentity(
  environment: KnownRuntimeEnvironment,
  options: { endpoint?: string; signal?: AbortSignal } = {}
) {
  options.signal?.throwIfAborted()
  const verifiedPairing = {
    ...getPreferredPairingOffer(environment),
    ...(options.endpoint ? { endpoint: options.endpoint } : {})
  }
  const response = await sendRemoteRuntimeRequest<RuntimeStatus>(
    verifiedPairing,
    'status.get',
    undefined,
    15_000,
    undefined,
    options.signal,
    ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
  )
  options.signal?.throwIfAborted()
  if (!response.ok) {
    throw new Error(`Runtime identity verification failed: ${response.error.message}`)
  }
  const status = verifyRemotePairingRuntimeStatus(response.result)
  if (!status.ok) {
    throw new Error(status.message)
  }
  const runtimeId = status.runtimeStatus.runtimeId
  if (
    response._meta.runtimeId !== runtimeId ||
    (environment.runtimeId !== null && runtimeId !== environment.runtimeId) ||
    (environment.pairedDeviceId !== undefined &&
      status.runtimeStatus.pairedDeviceId !== undefined &&
      status.runtimeStatus.pairedDeviceId !== environment.pairedDeviceId)
  ) {
    throw new Error('The endpoint does not match this paired runtime identity.')
  }
  return { verifiedPairing, verifiedRuntimeId: runtimeId, runtimeStatus: status.runtimeStatus }
}
