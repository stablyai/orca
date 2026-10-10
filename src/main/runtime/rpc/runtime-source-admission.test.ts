import './unused-default-rpc-methods.test-fixture'
import { z } from 'zod'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime'
import { publishHostDescriptor } from '../host-descriptor'
import { defineMethod, type RpcRequest } from './core'
import { RpcDispatcher } from './dispatcher'

const SOURCE_A = '11111111-1111-4111-8111-111111111111'
const SOURCE_B = '22222222-2222-4222-8222-222222222222'

describe('runtime source admission', () => {
  const published: string[] = []

  afterEach(() => {
    for (const runtimeId of published.splice(0)) {
      publishHostDescriptor(runtimeId, null)
    }
  })

  function createHarness(installationId: string | null = SOURCE_A) {
    const runtime = new OrcaRuntimeService()
    const runtimeId = runtime.getRuntimeId()
    if (installationId) {
      publishHostDescriptor(runtimeId, { installationId })
      published.push(runtimeId)
    }
    const effect = vi.fn(() => ({ sent: true }))
    const dispatcher = new RpcDispatcher({
      runtime,
      methods: [
        defineMethod({
          name: 'terminal.send',
          permission: 'workspace',
          params: z.object({ text: z.string() }),
          handler: effect
        })
      ]
    })
    const request = (expectedRuntimeSource?: unknown): RpcRequest => ({
      id: 'rpc_1',
      authToken: 'token',
      method: 'terminal.send',
      params: { text: 'hi' },
      ...(expectedRuntimeSource === undefined ? {} : { expectedRuntimeSource })
    })
    return { runtimeId, dispatcher, effect, request }
  }

  it('refuses a request meant for another profile before the handler runs', async () => {
    const { runtimeId, dispatcher, effect, request } = createHarness()

    const response = await dispatcher.dispatch(request({ sourceId: SOURCE_B, runtimeId }))

    expect(response).toMatchObject({ ok: false, error: { code: 'runtime_source_mismatch' } })
    expect(effect).not.toHaveBeenCalled()
  })

  it('refuses a request verified against another runtime of the same profile', async () => {
    const { dispatcher, effect, request } = createHarness()

    const response = await dispatcher.dispatch(
      request({ sourceId: SOURCE_A, runtimeId: 'runtime-other' })
    )

    expect(response).toMatchObject({ ok: false, error: { code: 'runtime_source_mismatch' } })
    expect(effect).not.toHaveBeenCalled()
  })

  it('runs a request meant for this runtime', async () => {
    const { runtimeId, dispatcher, effect, request } = createHarness()

    const response = await dispatcher.dispatch(request({ sourceId: SOURCE_A, runtimeId }))

    expect(response).toMatchObject({ ok: true, result: { sent: true } })
    expect(effect).toHaveBeenCalledOnce()
  })

  it('keeps today’s behaviour for a client that sends no expectation (old CLI)', async () => {
    const { dispatcher, effect, request } = createHarness(null)

    const response = await dispatcher.dispatch(request())

    expect(response).toMatchObject({ ok: true })
    expect(effect).toHaveBeenCalledOnce()
  })

  it('refuses when this runtime cannot say which profile it serves', async () => {
    const { runtimeId, dispatcher, effect, request } = createHarness(null)

    const response = await dispatcher.dispatch(request({ sourceId: SOURCE_A, runtimeId }))

    expect(response).toMatchObject({ ok: false, error: { code: 'runtime_source_unverifiable' } })
    expect(effect).not.toHaveBeenCalled()
  })

  it.each([null, 'source', { sourceId: SOURCE_A }, { sourceId: '', runtimeId: 'r' }])(
    'refuses a malformed expectation %j',
    async (expectation) => {
      const { dispatcher, effect, request } = createHarness()

      const response = await dispatcher.dispatch(request(expectation))

      expect(response).toMatchObject({ ok: false, error: { code: 'bad_request' } })
      expect(effect).not.toHaveBeenCalled()
    }
  )

  it('fences the streaming transport too', async () => {
    const { runtimeId, dispatcher, effect, request } = createHarness()
    const replies: string[] = []

    await dispatcher.dispatchStreaming(request({ sourceId: SOURCE_B, runtimeId }), (reply) =>
      replies.push(reply)
    )

    expect(JSON.parse(replies[0])).toMatchObject({
      ok: false,
      error: { code: 'runtime_source_mismatch' }
    })
    expect(effect).not.toHaveBeenCalled()
  })
})
