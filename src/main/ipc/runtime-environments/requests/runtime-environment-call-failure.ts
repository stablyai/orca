import type { resolveEnvironment } from '../../../../shared/remote-runtime/host-store/runtime-environment-store'
import { RemoteRuntimeClientError } from '../../../../shared/remote-runtime/remote-runtime-client-error'
import { RuntimeRpcCallQueueOverloadError } from '../../../../shared/remote-runtime/rpc/runtime-rpc-call-queue'
import type {
  RuntimeRpcFailure,
  RuntimeRpcResponse
} from '../../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import { runtimeEnvironmentManualDisconnectReason } from '../connectivity/runtime-environment-manual-disconnect'
import { clientMadeFailureData } from '../../../../shared/remote-runtime/rpc/runtime-rpc-client-made-failure'

/** `beforeSend`: refused before the call was made, so nothing was sent; after it, the call's fate is unknown. */
export function manuallyDisconnectedResponse(
  environment: Awaited<ReturnType<typeof resolveEnvironment>>,
  beforeSend = false
): RuntimeRpcResponse<never> {
  return {
    id: 'runtime.manualDisconnect',
    ok: false,
    error: {
      code: 'runtime_manually_disconnected',
      message: runtimeEnvironmentManualDisconnectReason(environment.id),
      data: clientMadeFailureData(undefined, beforeSend)
    },
    _meta: { runtimeId: environment.runtimeId }
  }
}

export function runtimeEnvironmentCallFailure(
  environment: Awaited<ReturnType<typeof resolveEnvironment>>,
  method: string,
  error: unknown
): RuntimeRpcFailure | null {
  if (
    !(error instanceof RemoteRuntimeClientError) &&
    !(error instanceof RuntimeRpcCallQueueOverloadError)
  ) {
    return null
  }
  return {
    id: method,
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      data: clientMadeFailureData(
        error instanceof RemoteRuntimeClientError ? error.data : undefined,
        error instanceof RemoteRuntimeClientError && provenUnsent(error)
      )
    },
    _meta: { runtimeId: environment.runtimeId }
  }
}

/** This Orca's own proof that nothing but the handshake left it: the socket's typed keyed-request
 *  flag, or a failure before the host authenticated us. Never `error.data`, which a server can fill. */
function provenUnsent(error: RemoteRuntimeClientError): boolean {
  return (
    error.requestUnsent === true ||
    (error.pairingStage !== undefined && error.pairingStage !== 'runtime')
  )
}
