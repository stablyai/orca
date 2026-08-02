import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
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
