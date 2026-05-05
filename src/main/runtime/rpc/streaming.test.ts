import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { RpcDispatcher } from './dispatcher'
import { defineMethod, defineStreamingMethod, type RpcRequest } from './core'
import type { OrcaRuntimeService } from '../orca-runtime'

function stubRuntime(overrides: Partial<OrcaRuntimeService> = {}): OrcaRuntimeService {
  return {
    getRuntimeId: () => 'test-runtime',
    ...overrides
  } as OrcaRuntimeService
}

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('RpcDispatcher streaming', () => {
  it('sends initial scrollback via emit', async () => {
    const messages: string[] = []
    const dispatcher = new RpcDispatcher({
      runtime: stubRuntime({
        readTerminal: vi.fn().mockResolvedValue({ tail: 'hello\nworld\n', truncated: false }),
        resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: null })
      }),
      methods: [
        defineStreamingMethod({
          name: 'terminal.subscribe',
          params: z.object({ terminal: z.string() }),
          handler: async (params, { runtime }, emit) => {
            const read = await (runtime as OrcaRuntimeService).readTerminal(params.terminal)
            emit({ type: 'scrollback', lines: read.tail, truncated: read.truncated })

            const leaf = (runtime as OrcaRuntimeService).resolveLeafForHandle(params.terminal)
            if (!leaf?.ptyId) {
              emit({ type: 'end' })
            }
          }
        })
      ]
    })

    await dispatcher.dispatchStreaming(
      makeRequest('terminal.subscribe', { terminal: 'h-1' }),
      (msg) => messages.push(msg)
    )

    expect(messages).toHaveLength(2)
    const scrollback = JSON.parse(messages[0]!)
    expect(scrollback).toMatchObject({
      ok: true,
      streaming: true,
      result: { type: 'scrollback', lines: 'hello\nworld\n', truncated: false }
    })
    const end = JSON.parse(messages[1]!)
    expect(end).toMatchObject({
      ok: true,
      streaming: true,
      result: { type: 'end' }
    })
  })

  it('streams live data chunks via emit', async () => {
    const messages: string[] = []
    let emitFn: ((result: unknown) => void) | null = null
    let resolveHandler: (() => void) | null = null

    const dispatcher = new RpcDispatcher({
      runtime: stubRuntime(),
      methods: [
        defineStreamingMethod({
          name: 'test.stream',
          params: null,
          handler: async (_params, _ctx, emit) => {
            emitFn = emit
            await new Promise<void>((resolve) => {
              resolveHandler = resolve
            })
          }
        })
      ]
    })

    const dispatchPromise = dispatcher.dispatchStreaming(makeRequest('test.stream'), (msg) =>
      messages.push(msg)
    )

    // Wait for handler to capture emit
    await vi.waitFor(() => expect(emitFn).not.toBeNull())

    emitFn!({ type: 'data', chunk: 'line 1\n' })
    emitFn!({ type: 'data', chunk: 'line 2\n' })
    emitFn!({ type: 'end' })
    resolveHandler!()

    await dispatchPromise

    expect(messages).toHaveLength(3)
    expect(JSON.parse(messages[0]!)).toMatchObject({
      streaming: true,
      result: { type: 'data', chunk: 'line 1\n' }
    })
    expect(JSON.parse(messages[1]!)).toMatchObject({
      streaming: true,
      result: { type: 'data', chunk: 'line 2\n' }
    })
    expect(JSON.parse(messages[2]!)).toMatchObject({
      streaming: true,
      result: { type: 'end' }
    })
  })

  it('unsubscribe stops further streaming', async () => {
    const messages: string[] = []
    let cleanup: (() => void) | null = null

    const dispatcher = new RpcDispatcher({
      runtime: stubRuntime({
        registerSubscriptionCleanup: vi.fn().mockImplementation((_id: string, fn: () => void) => {
          cleanup = fn
        }),
        cleanupSubscription: vi.fn().mockImplementation(() => {
          cleanup?.()
        })
      }),
      methods: [
        defineStreamingMethod({
          name: 'test.subscribe',
          params: null,
          handler: async (_params, { runtime }, emit) => {
            emit({ type: 'scrollback', lines: '' })

            await new Promise<void>((resolve) => {
              ;(runtime as OrcaRuntimeService).registerSubscriptionCleanup('sub-1', () => {
                emit({ type: 'end' })
                resolve()
              })
            })
          }
        }),
        defineMethod({
          name: 'test.unsubscribe',
          params: z.object({ subscriptionId: z.string() }),
          handler: async (params, { runtime }) => {
            ;(runtime as OrcaRuntimeService).cleanupSubscription(params.subscriptionId)
            return { unsubscribed: true }
          }
        })
      ]
    })

    const subPromise = dispatcher.dispatchStreaming(makeRequest('test.subscribe'), (msg) =>
      messages.push(msg)
    )

    await vi.waitFor(() => expect(cleanup).not.toBeNull())

    const unsubMessages: string[] = []
    await dispatcher.dispatchStreaming(
      {
        id: 'req-unsub',
        authToken: 'tok',
        method: 'test.unsubscribe',
        params: { subscriptionId: 'sub-1' }
      },
      (msg) => unsubMessages.push(msg)
    )

    await subPromise

    expect(unsubMessages).toHaveLength(1)
    expect(JSON.parse(unsubMessages[0]!)).toMatchObject({
      ok: true,
      result: { unsubscribed: true }
    })

    const streamMessages = messages.map((m) => JSON.parse(m))
    expect(streamMessages).toContainEqual(
      expect.objectContaining({ result: { type: 'scrollback', lines: '' } })
    )
    expect(streamMessages).toContainEqual(expect.objectContaining({ result: { type: 'end' } }))
  })

  it('falls back to one-shot dispatch for non-streaming methods via dispatchStreaming', async () => {
    const messages: string[] = []
    const dispatcher = new RpcDispatcher({
      runtime: stubRuntime(),
      methods: [
        defineMethod({
          name: 'status.get',
          params: null,
          handler: async () => ({ status: 'ok' })
        })
      ]
    })

    await dispatcher.dispatchStreaming(makeRequest('status.get'), (msg) => messages.push(msg))

    expect(messages).toHaveLength(1)
    const response = JSON.parse(messages[0]!)
    expect(response).toMatchObject({ ok: true, result: { status: 'ok' } })
    expect(response.streaming).toBeUndefined()
  })

  it('returns error for unknown method via dispatchStreaming', async () => {
    const messages: string[] = []
    const dispatcher = new RpcDispatcher({
      runtime: stubRuntime(),
      methods: []
    })

    await dispatcher.dispatchStreaming(makeRequest('nonexistent.method'), (msg) =>
      messages.push(msg)
    )

    expect(messages).toHaveLength(1)
    expect(JSON.parse(messages[0]!)).toMatchObject({
      ok: false,
      error: { code: 'method_not_found' }
    })
  })

  it('returns error when streaming method is called via one-shot dispatch', async () => {
    const dispatcher = new RpcDispatcher({
      runtime: stubRuntime(),
      methods: [
        defineStreamingMethod({
          name: 'test.stream',
          params: null,
          handler: async () => {}
        })
      ]
    })

    const response = await dispatcher.dispatch(makeRequest('test.stream'))

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'method_not_supported' }
    })
  })

  it('captures handler errors in streaming dispatch', async () => {
    const messages: string[] = []
    const dispatcher = new RpcDispatcher({
      runtime: stubRuntime(),
      methods: [
        defineStreamingMethod({
          name: 'test.explode',
          params: null,
          handler: async () => {
            throw new Error('boom')
          }
        })
      ]
    })

    await dispatcher.dispatchStreaming(makeRequest('test.explode'), (msg) => messages.push(msg))

    expect(messages).toHaveLength(1)
    expect(JSON.parse(messages[0]!)).toMatchObject({
      ok: false,
      error: { code: 'runtime_error' }
    })
  })
})
