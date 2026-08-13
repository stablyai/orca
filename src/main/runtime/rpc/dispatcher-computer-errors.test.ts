import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { RpcDispatcher } from './dispatcher'
import { defineMethod, InvalidArgumentError, type RpcRequest } from './core'
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
  }),
  defineMethod({
    name: 'orchestration.throwZod',
    params: z.object({}),
    handler: () =>
      z.object({ title: z.string().min(1, 'Handler title missing') }).parse({ title: '' })
  }),
  defineMethod({
    name: 'orchestration.invalidArgument',
    params: z.object({}),
    handler: () => {
      throw new InvalidArgumentError('Async validation rejected payload')
    }
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

  it('preserves formatted Zod issue messages thrown by method handlers', async () => {
    const dispatcher = new RpcDispatcher({ runtime: makeRuntime(), methods: METHODS })

    const response = await dispatcher.dispatch(makeRequest('orchestration.throwZod', {}))

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_argument',
        message: 'Handler title missing'
      }
    })
  })

  it('maps async validation errors to invalid_argument without shadowing Zod formatting', async () => {
    const dispatcher = new RpcDispatcher({ runtime: makeRuntime(), methods: METHODS })

    const response = await dispatcher.dispatch(makeRequest('orchestration.invalidArgument', {}))

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_argument',
        message: 'Async validation rejected payload'
      }
    })
  })
})
