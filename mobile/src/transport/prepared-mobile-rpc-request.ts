import type { RpcClient } from './rpc-client'
import type { ConnectionState, RpcResponse } from './types'
import { openRpcRequestBudget, resolvePostConnectRequestTimeout } from './rpc-request-budget'
import {
  prepareRemoteRuntimeRequest,
  releaseRemoteRuntimePreparedRequest,
  takeRemoteRuntimePreparedRequest,
  type RemoteRuntimePreparedRequest
} from '../../../src/shared/remote-runtime/requests/remote-runtime-prepared-request-admission'
import type { RpcEnvelopeFields } from './rpc-envelope-fields'

type Request = { method: string; params?: unknown; envelope?: RpcEnvelopeFields }
export type PreparedMobileRpcRequests = Map<
  object,
  { preparedRequest: RemoteRuntimePreparedRequest | null }
>
export async function withPreparedMobileRpcRequest<T>(
  pending: PreparedMobileRpcRequests,
  request: Request,
  send: (snapshot: Request) => Promise<T>
): Promise<T> {
  const key = {}
  const held = {
    preparedRequest: prepareRemoteRuntimeRequest(
      pending,
      () => JSON.stringify(request),
      (json) => 6 * json.length + 64 * 1024
    )
  }
  pending.set(key, held)
  try {
    const json = takeRemoteRuntimePreparedRequest(held)
    if (!json) {
      throw new Error('Request abandoned')
    }
    const snapshot: Request = JSON.parse(json)
    return await send(snapshot)
  } finally {
    releaseRemoteRuntimePreparedRequest(held)
    pending.delete(key)
  }
}

export function preparedMobileRequestSender(args: {
  getState: () => ConnectionState
  waitForConnected: (timeoutMs?: number) => Promise<void>
  send: (
    method: string,
    params: unknown,
    timeoutMs: number,
    envelope?: RpcEnvelopeFields
  ) => Promise<RpcResponse>
  observe: (
    method: string,
    response: RpcResponse,
    current: boolean,
    envelope?: RpcEnvelopeFields
  ) => RpcResponse
  requestTimeoutMs: number
}): RpcClient['sendRequest'] {
  const pending: PreparedMobileRpcRequests = new Map()
  return async (method, params, options) => {
    const budget = openRpcRequestBudget(options)
    if (options?.failWhenDisconnected && args.getState() !== 'connected') {
      throw new Error(`Not connected: ${method}`)
    }
    return withPreparedMobileRpcRequest(
      pending,
      { method, params, envelope: options?.envelope },
      async (snapshot) => {
        await args.waitForConnected(budget.timeoutMs)
        const response = await args.send(
          snapshot.method,
          snapshot.params,
          resolvePostConnectRequestTimeout(budget, args.requestTimeoutMs),
          snapshot.envelope
        )
        return args.observe(snapshot.method, response, true, snapshot.envelope)
      }
    )
  }
}
