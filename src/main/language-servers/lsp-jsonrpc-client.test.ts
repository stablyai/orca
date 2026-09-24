import { describe, expect, it, vi } from 'vitest'
import { createLspFrameParser, encodeLspMessage } from '../../shared/lsp-content-length-framer'
import { createLspJsonRpcClient, type LspJsonRpcClient } from './lsp-jsonrpc-client'

type Harnes = {
  client: LspJsonRpcClient
  toServer: Buffer[]
  notifications: { method: string; params: unknown }[]
  serverRequests: { method: string; params: unknown }[]
  errors: Error[]
}

function harness(
  onServerRequest: (method: string, params: unknown) => unknown = () => undefined
): Harnes {
  const toServer: Buffer[] = []
  const notifications: { method: string; params: unknown }[] = []
  const serverRequests: { method: string; params: unknown }[] = []
  const errors: Error[] = []
  const client = createLspJsonRpcClient((bytes) => toServer.push(bytes), {
    onServerNotification: (method, params) => notifications.push({ method, params }),
    onServerRequest: (method, params) => {
      serverRequests.push({ method, params })
      return onServerRequest(method, params)
    },
    onProtocolError: (error) => errors.push(error)
  })
  return { client, toServer, notifications, serverRequests, errors }
}

function decode(bytes: Buffer[]): unknown[] {
  const messages: unknown[] = []
  const parser = createLspFrameParser(
    (message) => messages.push(message),
    () => {}
  )
  parser.feed(Buffer.concat(bytes))
  return messages
}

/** Server -> client direction. */
function feed(client: LspJsonRpcClient, message: unknown): void {
  client.feed(encodeLspMessage(message))
}

describe('createLspJsonRpcClient', () => {
  it('sends requests with incrementing ids and resolves the matching response', async () => {
    const { client, toServer } = harness()
    const first = client.request('initialize', { a: 1 })
    const second = client.request('shutdown', null)
    const sent = decode(toServer)
    expect(sent[0]).toMatchObject({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { a: 1 } })
    expect(sent[1]).toMatchObject({ jsonrpc: '2.0', id: 2, method: 'shutdown', params: null })

    feed(client, { jsonrpc: '2.0', id: 2, result: 'done' })
    await expect(second).resolves.toBe('done')
    feed(client, { jsonrpc: '2.0', id: 1, result: { capabilities: {} } })
    await expect(first).resolves.toEqual({ capabilities: {} })
  })

  it('rejects on a response error with the code and message', async () => {
    const { client } = harness()
    const pending = client.request('textDocument/definition', {})
    feed(client, { jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'bad params' } })
    const error = await pending.then(
      () => {
        throw new Error('expected rejection')
      },
      (error: Error) => error
    )
    expect(error.message).toContain('textDocument/definition')
    expect(error.message).toContain('-32602')
    expect(error.message).toContain('bad params')
  })

  it('answers server requests with the handler result (null when undefined)', async () => {
    const answers: unknown[] = []
    const { client, toServer, serverRequests } = harness((method, params) => {
      if (method === 'workspace/configuration') {
        return (params as { items: unknown[] }).items.map(() => null)
      }
      return undefined
    })
    feed(client, {
      jsonrpc: '2.0',
      id: 10,
      method: 'window/workDoneProgress/create',
      params: { token: 't1' }
    })
    feed(client, {
      jsonrpc: '2.0',
      id: 11,
      method: 'workspace/configuration',
      params: { items: [{}, {}] }
    })
    await new Promise((resolve) => setImmediate(resolve))
    answers.push(...decode(toServer))
    expect(serverRequests.map((r) => r.method)).toEqual([
      'window/workDoneProgress/create',
      'workspace/configuration'
    ])
    expect(answers).toEqual([
      { jsonrpc: '2.0', id: 10, result: null },
      { jsonrpc: '2.0', id: 11, result: [null, null] }
    ])
  })

  it('answers a throwing handler with an internal-error response', async () => {
    const { client, toServer } = harness(() => {
      throw new Error('handler blew up')
    })
    feed(client, { jsonrpc: '2.0', id: 7, method: 'workspace/configuration', params: {} })
    await new Promise((resolve) => setImmediate(resolve))
    const responses = decode(toServer)
    expect(responses[0]).toMatchObject({
      id: 7,
      error: { code: -32603, message: 'handler blew up' }
    })
  })

  it('dispatches notifications without ids to the handler', () => {
    const { client, notifications } = harness()
    feed(client, { jsonrpc: '2.0', method: '$/progress', params: { token: 1 } })
    expect(notifications).toEqual([{ method: '$/progress', params: { token: 1 } }])
  })

  it('flags a response for an unknown id as a protocol error', () => {
    const { client, errors } = harness()
    feed(client, { jsonrpc: '2.0', id: 999, result: null })
    expect(errors).toHaveLength(1)
    expect(errors[0].message).toContain('unknown request id 999')
  })

  it('times out a request that never gets answered', async () => {
    vi.useFakeTimers()
    try {
      const { client } = harness()
      const pending = client.request('slow', undefined, { timeoutMs: 50 })
      const assertion = expect(pending).rejects.toThrow('exceeded 50ms')
      await vi.advanceTimersByTimeAsync(60)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('die() rejects every pending request exactly once', async () => {
    const { client } = harness()
    const one = client.request('a')
    const two = client.request('b')
    client.die('exit')
    await expect(one).rejects.toThrow('LSP session died: exit')
    await expect(two).rejects.toThrow('LSP session died: exit')
    await expect(client.request('after-death')).rejects.toThrow('LSP session died: exit')
    expect(client.dead).toBe(true)
  })

  it('notify after death is silently dropped, not thrown', () => {
    const { client, toServer } = harness()
    client.die('exit')
    expect(() => client.notify('textDocument/didOpen', {})).not.toThrow()
    expect(toServer).toHaveLength(0)
  })
})
