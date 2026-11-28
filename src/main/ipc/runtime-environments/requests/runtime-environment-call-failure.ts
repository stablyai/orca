import type { resolveEnvironment } from '../../../../shared/remote-runtime/host-store/runtime-environment-store'
import { RemoteRuntimeClientError } from '../../../../shared/remote-runtime/remote-runtime-client-error'
import { RuntimeRpcCallQueueOverloadError } from '../../../../shared/remote-runtime/rpc/runtime-rpc-call-queue'
import type {
  RuntimeRpcFailure,
  RuntimeRpcResponse
} from '../../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import { runtimeEnvironmentManualDisconnectReason } from '../connectivity/runtime-environment-manual-disconnect'
import { CLIENT_MADE_FAILURE_DATA } from '../../../../shared/remote-runtime/rpc/runtime-rpc-client-made-failure'

export function manuallyDisconnectedResponse(
  environment: Awaited<ReturnType<typeof resolveEnvironment>>
): RuntimeRpcResponse<never> {
  return {
    id: 'runtime.manualDisconnect',
    ok: false,
    error: {
      code: 'runtime_manually_disconnected',
      message: runtimeEnvironmentManualDisconnectReason(environment.id),
      data: CLIENT_MADE_FAILURE_DATA
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
    error: { code: error.code, message: error.message, data: CLIENT_MADE_FAILURE_DATA },
    _meta: { runtimeId: environment.runtimeId }
  }
}
