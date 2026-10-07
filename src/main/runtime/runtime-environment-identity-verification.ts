import {
  getPreferredPairingOffer,
  type KnownRuntimeEnvironment
} from '../../shared/runtime-environments'
import { sendRemoteRuntimeRequest } from '../../shared/remote-runtime-client'
import { verifyRemotePairingRuntimeStatus } from '../../shared/remote-pairing-verification'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../shared/electron-remote-runtime-client-capabilities'
import type { RuntimeStatus } from '../../shared/runtime-types'
import type { PairingOffer } from '../../shared/pairing'

export const RUNTIME_IDENTITY_MISMATCH_MESSAGE =
  'The endpoint does not match this paired runtime identity.'

export function verifyRuntimeEnvironmentIdentity(
  environment: KnownRuntimeEnvironment,
  options: { endpoint?: string; signal?: AbortSignal } = {}
) {
  return verifyRuntimePairingIdentity(
    {
      ...getPreferredPairingOffer(environment),
      ...(options.endpoint ? { endpoint: options.endpoint } : {})
    },
    environment,
    options.signal
  )
}

/** Proves the runtime at `pairing` holds its keys and is the expected runtime. */
export async function verifyRuntimePairingIdentity(
  verifiedPairing: PairingOffer,
  expected: Pick<KnownRuntimeEnvironment, 'runtimeId' | 'pairedDeviceId'>,
  signal?: AbortSignal
) {
  signal?.throwIfAborted()
  const response = await sendRemoteRuntimeRequest<RuntimeStatus>(
    verifiedPairing,
    'status.get',
    undefined,
    15_000,
    undefined,
    signal,
    ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
  )
  signal?.throwIfAborted()
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
    (expected.runtimeId !== null && runtimeId !== expected.runtimeId) ||
    (expected.pairedDeviceId !== undefined &&
      status.runtimeStatus.pairedDeviceId !== undefined &&
      status.runtimeStatus.pairedDeviceId !== expected.pairedDeviceId)
  ) {
    throw new Error(RUNTIME_IDENTITY_MISMATCH_MESSAGE)
  }
  return {
    verifiedPairing,
    verifiedRuntimeId: runtimeId,
    runtimeStatus: status.runtimeStatus
  }
}
