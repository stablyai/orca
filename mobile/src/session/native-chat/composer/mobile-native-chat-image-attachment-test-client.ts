import { vi } from 'vitest'
import type { RpcClient } from '../../../transport/rpc-client'
import type { RpcResponse, RpcSuccess } from '../../../transport/types'

export function ok(id: string, result: unknown): RpcSuccess {
  return { id, ok: true, result, _meta: { runtimeId: 'r' } }
}

export function methodNotFound(id: string): RpcResponse {
  return {
    id,
    ok: false,
    error: { code: 'method_not_found', message: 'no' },
    _meta: { runtimeId: 'r' }
  }
}

export function sendResult(accepted: boolean): RpcSuccess {
  return { id: 'send', ok: true, result: { send: { accepted } }, _meta: { runtimeId: 'r' } }
}

export function makeClient(responses: (RpcResponse | Promise<RpcResponse>)[]): Pick<
  RpcClient,
  'sendRequest'
> & {
  calls: { method: string; params: Record<string, unknown> }[]
} {
  const calls: { method: string; params: Record<string, unknown> }[] = []
  return {
    calls,
    sendRequest: vi.fn(async (method: string, params?: unknown) => {
      if (method === 'terminal.read') {
        return ok('read', {})
      }
      calls.push({ method, params: params as Record<string, unknown> })
      const response = responses.shift()
      if (!response) {
        throw new Error(`unexpected request: ${method}`)
      }
      return response
    })
  }
}
