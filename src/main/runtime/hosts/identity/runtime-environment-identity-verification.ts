import {
  getPreferredPairedRuntimeConnection,
  type KnownRuntimeEnvironment
} from '../../../../shared/remote-runtime/host-catalog/runtime-environments'
import { sendRemoteRuntimeRequestOnSocket } from '../../../../shared/remote-runtime/requests/remote-runtime-request-socket'
import { verifyRemotePairingRuntimeStatus } from '../../../../shared/remote-runtime/pairing/remote-pairing-verification'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../../../shared/electron-remote-runtime-client-capabilities'
import type { RuntimeStatus } from '../../../../shared/runtime-session-contracts'
import type { PairedRuntimeConnection } from '../../../../shared/remote-runtime/pairing/paired-runtime-connection'

export const RUNTIME_IDENTITY_MISMATCH_MESSAGE =
  'The endpoint does not match this paired runtime identity.'

export function verifyRuntimeEnvironmentIdentity(
  environment: KnownRuntimeEnvironment,
  options: { endpoint?: string; signal?: AbortSignal } = {}
) {
  return verifyRuntimePairingIdentity(
    {
      ...getPreferredPairedRuntimeConnection(environment),
      ...(options.endpoint ? { endpoint: options.endpoint } : {})
    },
    environment,
    options.signal
  )
}

/** Proves the runtime at `connection` holds its keys and is the expected runtime. */
export async function verifyRuntimePairingIdentity(
  connection: PairedRuntimeConnection,
  expected: Pick<KnownRuntimeEnvironment, 'runtimeId' | 'pairedDeviceId'>,
  signal?: AbortSignal
) {
  signal?.throwIfAborted()
  const response = await sendRemoteRuntimeRequestOnSocket<RuntimeStatus>(
    connection,
    'status.get',
    undefined,
    15_000,
    undefined,
    undefined,
    signal,
    ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES,
    undefined,
    undefined
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
    verifiedConnection: connection,
    verifiedRuntimeId: runtimeId,
    runtimeStatus: status.runtimeStatus
  }
}
