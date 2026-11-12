import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineMethod, type RpcEnvelopeMeta, type RpcRequest } from '../core'
import { parseRpcRequestParams } from './dispatcher-request-parsing'

const META: RpcEnvelopeMeta = { runtimeId: 'runtime-1' }

function request(params: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'token', method: 'test.parse', params }
}

describe('parseRpcRequestParams', () => {
  it('preserves validation errors from the runtime fallback', () => {
    const method = defineMethod({
      name: 'test.parse',
      permission: 'workspace',
      params: z.object({ count: z.number().int('Count must be an integer') }),
      handler: () => null
    })

    expect(parseRpcRequestParams(request({ count: 1.5 }), method, META)).toMatchObject({
      error: {
        id: 'req-1',
        _meta: { runtimeId: 'runtime-1' },
        ok: false,
        error: { code: 'invalid_argument', message: 'Count must be an integer' }
      }
    })
  })
})
