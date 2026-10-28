import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type { KnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import { withRuntimeUnreachableHint } from './runtime-environment-unreachable-hint'

export function withTailscaleHintForResponse<TResult>(
  response: RuntimeRpcResponse<TResult>,
  endpoint: string,
  environment: Pick<KnownRuntimeEnvironment, 'orcadDeployment'>
): RuntimeRpcResponse<TResult> {
  if (response.ok === true) {
    return response
  }
  return {
    ...response,
    error: {
      ...response.error,
      message: withRuntimeUnreachableHint(environment, response.error.message, endpoint)
    }
  }
}
