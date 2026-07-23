import { describe, expect, it, vi } from 'vitest'
import { REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES } from '../../../shared/remote-runtime-memory-limits'
import type { OrcaRuntimeService } from '../orca-runtime'
import { defineMethod, defineStreamingMethod, type RpcRequest } from './core'
import { RpcDispatcher } from './dispatcher'

const request = (method: string): RpcRequest => ({
  id: 'request-1',
  authToken: 'unused',
  method
})

function runtime(): OrcaRuntimeService {
  return {
    getRuntimeId: () => 'runtime-1',
    recordFeatureInteraction: vi.fn()
  } as unknown as OrcaRuntimeService
}

describe('RpcDispatcher outbound response bounds', () => {
  it('preserves ordinary streaming response serialization byte-for-byte', async () => {
    const dispatcher = new RpcDispatcher({
      runtime: runtime(),
      methods: [
        defineMethod({
          name: 'test.normal',
          params: null,
          handler: () => ({ text: 'hello 😀' })
        })
      ]
    })
    const reply = vi.fn()

    await dispatcher.dispatchStreaming(request('test.normal'), reply)

    expect(reply).toHaveBeenCalledWith(
      JSON.stringify({
        id: 'request-1',
        ok: true,
        result: { text: 'hello 😀' },
        _meta: { runtimeId: 'runtime-1' }
      })
    )
  })

  it('replaces an oversized one-shot result with a small correlated error', async () => {
    const dispatcher = new RpcDispatcher({
      runtime: runtime(),
      methods: [
        defineMethod({
          name: 'test.oversized',
          params: null,
          handler: () => ({ text: 'x'.repeat(REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES) })
        })
      ]
    })

    const response = await dispatcher.dispatch(request('test.oversized'))

    expect(response).toMatchObject({
      id: 'request-1',
      ok: false,
      error: { code: 'response_too_large' },
      _meta: { runtimeId: 'runtime-1' }
    })
    expect(Buffer.byteLength(JSON.stringify(response), 'utf8')).toBeLessThan(
      REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES
    )
  })

  it('bounds an oversized streaming emission before calling the reply transport', async () => {
    const dispatcher = new RpcDispatcher({
      runtime: runtime(),
      methods: [
        defineStreamingMethod({
          name: 'test.stream-oversized',
          params: null,
          handler: async (_params, _context, emit) => {
            emit({ text: 'x'.repeat(REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES) })
          }
        })
      ]
    })
    const reply = vi.fn()

    await dispatcher.dispatchStreaming(request('test.stream-oversized'), reply)

    expect(reply).toHaveBeenCalledOnce()
    const response = JSON.parse(reply.mock.calls[0]![0] as string) as {
      id: string
      ok: boolean
      error: { code: string }
    }
    expect(response).toMatchObject({
      id: 'request-1',
      ok: false,
      error: { code: 'response_too_large' }
    })
  })
})
