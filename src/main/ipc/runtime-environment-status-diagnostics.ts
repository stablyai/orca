import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import { REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY } from '../../shared/protocol-version'
import { getRemoteRuntimeSharedControlDiagnostics } from './runtime-environment-request-connections'

export function attachRemoteControlDiagnostics<TResult extends object>(
  response: RuntimeRpcResponse<TResult>,
  environmentId: string
): RuntimeRpcResponse<TResult> {
  const remoteControl = getRemoteRuntimeSharedControlDiagnostics(environmentId)
  if (!remoteControl) {
    return response
  }
  if (response.ok) {
    const capabilities = (response.result as { capabilities?: readonly string[] }).capabilities
    if (!capabilities?.includes(REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY)) {
      return response
    }
    return { ...response, result: { ...(response.result as object), remoteControl } as TResult }
  }
  return {
    ...response,
    error: {
      ...response.error,
      data:
        typeof response.error.data === 'object' && response.error.data !== null
          ? { ...response.error.data, remoteControl }
          : { remoteControl }
    }
  }
}
