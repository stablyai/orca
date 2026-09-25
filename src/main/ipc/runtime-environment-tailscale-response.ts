import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import { withRemoteRuntimeTailscaleHint } from '../../shared/remote-runtime-tailscale-hint'

export function withTailscaleHintForResponse<TResult>(
  response: RuntimeRpcResponse<TResult>,
  /** Null when the offer is dialed through a tunnel, where a Tailscale hint would mislead. */
  endpoint: string | null
): RuntimeRpcResponse<TResult> {
  if (response.ok === true || endpoint === null) {
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
