import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineMethod, type RpcEnvelopeMeta, type RpcRequest } from './core'
import { parseRpcRequestParams } from './dispatcher-request-parsing'

const META: RpcEnvelopeMeta = { runtimeId: 'runtime-1' }

function request(params: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'token', method: 'test.parse', params }
}

describe('parseRpcRequestParams', () => {
  it('parses repeated valid requests through the compiled schema', () => {
    const method = defineMethod({
      name: 'test.parse',
      params: z.object({ requestId: z.string().min(1), count: z.number().int().nonnegative() }),
      handler: () => null
    })

    expect(parseRpcRequestParams(request({ requestId: 'a', count: 1 }), method, META)).toEqual({
      value: { requestId: 'a', count: 1 }
    })
    expect(parseRpcRequestParams(request({ requestId: 'b', count: 2 }), method, META)).toEqual({
      value: { requestId: 'b', count: 2 }
    })
  })

  it('preserves validation errors from the runtime fallback', () => {
    const method = defineMethod({
      name: 'test.parse',
      params: z.object({ count: z.number().int('Count must be an integer') }),
      handler: () => null
    })

    expect(parseRpcRequestParams(request({ count: 1.5 }), method, META)).toMatchObject({
      error: {
        ok: false,
        error: { code: 'invalid_argument', message: 'Count must be an integer' }
      }
    })
  })

  it('keeps transform output when compilation falls back', () => {
    const method = defineMethod({
      name: 'test.parse',
      params: z.object({ value: z.string().transform((value) => value.toUpperCase()) }),
      handler: () => null
    })

    expect(parseRpcRequestParams(request({ value: 'ok' }), method, META)).toEqual({
      value: { value: 'OK' }
    })
  })
})
