import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { RpcDispatcher } from './dispatcher'
import { defineMethod, type RpcRequest } from './core'
import type { OrcaRuntimeService } from '../orca-runtime'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

function makeRuntime(): OrcaRuntimeService {
  return {
    getRuntimeId: () => 'test-runtime'
  } as OrcaRuntimeService
}

const METHODS = [
  defineMethod({
    name: 'computer.click',
    params: z.object({ app: z.string().min(1, 'Missing app') }),
    handler: () => ({ ok: true })
  }),
  defineMethod({
    name: 'browser.click',
    params: z.object({ page: z.string().min(1, 'Missing page') }),
    handler: () => ({ ok: true })
  })
]

describe('RpcDispatcher computer-use validation errors', () => {
  it('adds recovery steps to one-shot computer schema failures', async () => {
    const dispatcher = new RpcDispatcher({ runtime: makeRuntime(), methods: METHODS })

    const response = await dispatcher.dispatch(makeRequest('computer.click', {}))

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_argument',
        message: expect.stringContaining('expected string'),
        data: {
          nextSteps: expect.arrayContaining([
            expect.stringContaining('Fix the command flags or RPC params'),
            expect.stringContaining('Do not retry')
          ])
        }
      }
    })
  })

  it('adds recovery steps to streaming-transport computer schema failures', async () => {
    const messages: string[] = []
    const dispatcher = new RpcDispatcher({ runtime: makeRuntime(), methods: METHODS })

    await dispatcher.dispatchStreaming(makeRequest('computer.click', {}), (message) =>
      messages.push(message)
    )

    expect(JSON.parse(messages[0]!)).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_argument',
        data: {
          nextSteps: expect.arrayContaining([expect.stringContaining('Do not retry')])
        }
      }
    })
  })

  it('does not add computer-use recovery steps to unrelated schema failures', async () => {
    const dispatcher = new RpcDispatcher({ runtime: makeRuntime(), methods: METHODS })

    const response = await dispatcher.dispatch(makeRequest('browser.click', {}))

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_argument',
        message: expect.stringContaining('expected string')
      }
    })
    expect(response.ok === false ? response.error : null).not.toHaveProperty('data')
  })
})
