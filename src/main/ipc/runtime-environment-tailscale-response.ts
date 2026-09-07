import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import { withRemoteRuntimeTailscaleHint } from '../../shared/remote-runtime-tailscale-hint'

export function withTailscaleHintForResponse<TResult>(
  response: RuntimeRpcResponse<TResult>,
  endpoint: string
): RuntimeRpcResponse<TResult> {
  if (response.ok === true) {
    return response
  }
  return {
    ...response,
    error: {
      ...response.error,
      message: withRemoteRuntimeTailscaleHint(response.error.message, endpoint)
    }
  }
}
