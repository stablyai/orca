import type { resolveEnvironment } from '../../../shared/remote-runtime/host-store/runtime-environment-store'
import { RemoteRuntimeClientError } from '../../../shared/remote-runtime/remote-runtime-client-error'
import { RuntimeRpcCallQueueOverloadError } from '../../../shared/runtime-rpc-call-queue'
import type { RuntimeRpcFailure, RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import { runtimeEnvironmentManualDisconnectReason } from './runtime-environment-manual-disconnect'

export function manuallyDisconnectedResponse(
  environment: ReturnType<typeof resolveEnvironment>
): RuntimeRpcResponse<never> {
  return {
    id: 'runtime.manualDisconnect',
    ok: false,
    error: {
      code: 'runtime_manually_disconnected',
      message: runtimeEnvironmentManualDisconnectReason(environment.id)
    },
    _meta: { runtimeId: environment.runtimeId }
  }
}

export function runtimeEnvironmentCallFailure(
  environment: ReturnType<typeof resolveEnvironment>,
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
    error: { code: error.code, message: error.message },
    _meta: { runtimeId: environment.runtimeId }
  }
}
