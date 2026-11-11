import { describe, expect, it } from 'vitest'
import type { OrcaRuntimeService } from '../orca-runtime'
import { defineStreamingMethod, type RpcResponse } from './core'
import { RpcDispatcher } from './dispatcher'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: These test methods only read the runtime ID; optional runtime hooks are absent.
const runtime = { getRuntimeId: () => 'test-runtime' } as OrcaRuntimeService

describe('object and JSON stream transports', () => {
  it('preserves ordered stream results and errors across structured cloning and JSON', async () => {
    const dispatcher = new RpcDispatcher({
      runtime,
      methods: [
        defineStreamingMethod({
          name: 'test.stream',
          permission: 'workspace',
          params: null,
          handler: async (_params, _ctx, emit) => {
            emit({ type: 'text', text: 'hello\n"😀' })
            emit({ type: 'end' })
            throw new Error('boom')
          }
        })
      ]
    })
    const request = { id: 'sub-1', authToken: 'token', method: 'test.stream' }
    const objects: RpcResponse[] = []
    const json: string[] = []
    await dispatcher.dispatchStreamingObjects(request, (response) =>
      objects.push(structuredClone(response))
    )
    await dispatcher.dispatchStreaming(request, (response) => json.push(response))

    expect(objects).toEqual([
      {
        id: 'sub-1',
        ok: true,
        result: { type: 'text', text: 'hello\n"😀' },
        _meta: { runtimeId: 'test-runtime' },
        streaming: true
      },
      {
        id: 'sub-1',
        ok: true,
        result: { type: 'end' },
        _meta: { runtimeId: 'test-runtime' },
        streaming: true
      },
      {
        id: 'sub-1',
        ok: false,
        error: { code: 'runtime_error', message: 'boom' },
        _meta: { runtimeId: 'test-runtime' }
      }
    ])
    expect(json).toEqual([
      '{"id":"sub-1","ok":true,"result":{"type":"text","text":"hello\\n\\"😀"},"_meta":{"runtimeId":"test-runtime"},"streaming":true}',
      '{"id":"sub-1","ok":true,"result":{"type":"end"},"_meta":{"runtimeId":"test-runtime"},"streaming":true}',
      '{"id":"sub-1","ok":false,"error":{"code":"runtime_error","message":"boom"},"_meta":{"runtimeId":"test-runtime"}}'
    ])
  })
})
