// The orchestration RPC surface as the coordinator-mail suite calls it: each request numbered,
// under the current contract, naming the caller's agent session as its compatibility evidence.

import { ORCHESTRATION_CONTRACT_VERSION } from '../../shared/protocol-version'
import type { RpcRequest } from './rpc/core'
import type { RpcDispatcher } from './rpc/dispatcher'
import { resultOf } from './rpc/orchestration-session-caller-test-fixture'

export function createCoordinatorRpcCaller(dispatcher: () => RpcDispatcher) {
  let requests = 0

  function request(
    method: string,
    params: Record<string, unknown>,
    options: { sessionId?: string } = {}
  ): RpcRequest {
    requests += 1
    return {
      id: `rpc-${requests}`,
      authToken: 'test',
      method,
      params,
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: `req-${requests}`,
      ...(options.sessionId
        ? { orchestrationCompatibilityEvidence: { agentSessionId: options.sessionId } }
        : {})
    }
  }

  async function call(
    method: string,
    params: Record<string, unknown>,
    options?: { sessionId?: string }
  ): Promise<Record<string, unknown>> {
    const response = await dispatcher().dispatch(request(method, params, options))
    if (!response.ok) {
      throw new Error(`${method} failed: ${JSON.stringify(response)}`)
    }
    return resultOf(response)
  }

  return { request, call }
}
