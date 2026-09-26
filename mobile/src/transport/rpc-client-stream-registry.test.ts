import { describe, expect, it } from 'vitest'
import { RpcClientStreamRegistry } from './rpc-client-stream-registry'
import { encodeTerminalStreamFrame, TerminalStreamOpcode } from './terminal-stream-protocol'
import type { ConnectionState, RpcResponse } from './types'

type SentRequest = {
  id: string
  method: string
  params?: unknown
}

function createRegistry(initialState: ConnectionState = 'connected') {
  const sent: SentRequest[] = []
  let state = initialState
  let id = 0
  const registry = new RpcClientStreamRegistry({
    nextId: () => `rpc-${++id}`,
    deviceToken: 'device-token',
    getState: () => state,
    sendEncrypted: (request) => {
      sent.push(request as SentRequest)
      return true
    }
  })
  return {
    registry,
    sent,
    setState(next: ConnectionState) {
      state = next
    }
  }
}

function streamingResponse(id: string, result: unknown): RpcResponse {
  return {
    id,
    ok: true,
    streaming: true,
    result,
    _meta: { runtimeId: 'runtime-1' }
  }
}

function terminalOutput(streamId: number, chunk: string): Uint8Array {
  return encodeTerminalStreamFrame({
    opcode: TerminalStreamOpcode.Output,
    streamId,
    seq: 1,
    payload: new TextEncoder().encode(chunk)
  })
}

describe('RpcClientStreamRegistry', () => {
  it('replays the latest terminal viewport without retaining stale stream routing', () => {
    const { registry, sent } = createRegistry()
    const events: unknown[] = []
    registry.subscribe(
      'terminal.subscribe',
      { terminal: 'term-1', viewport: { cols: 45, rows: 20 } },
      (event) => events.push(event)
    )
    const first = sent[0]!
    registry.handleResponse(streamingResponse(first.id, { type: 'subscribed', streamId: 7 }))
    registry.handleBinary(terminalOutput(7, 'before'))

    registry.updateTerminalViewport('term-1', { cols: 60, rows: 24 })
    registry.markForReplay()
    registry.replayAfterAuthentication()
    registry.handleBinary(terminalOutput(7, 'stale'))

    expect(sent[1]).toMatchObject({
      id: first.id,
      method: 'terminal.subscribe',
      params: { terminal: 'term-1', viewport: { cols: 60, rows: 24 } }
    })
    expect(events).toEqual([
      { type: 'subscribed', streamId: 7 },
      { type: 'data', streamId: 7, chunk: 'before' }
    ])
  })

  it('keeps a disposed browser tombstone until ready can be unsubscribed', () => {
    const { registry, sent } = createRegistry()
    const dispose = registry.subscribe('browser.screencast', { page: 'page-1' }, () => {})
    const request = sent[0]!

    dispose()
    expect(sent).toHaveLength(1)

    registry.handleResponse(
      streamingResponse(request.id, {
        type: 'ready',
        subscriptionId: 'browser-screencast:page-1:test'
      })
    )
    expect(sent[1]).toMatchObject({
      method: 'browser.screencast.unsubscribe',
      params: { subscriptionId: 'browser-screencast:page-1:test' }
    })
  })

  it('releases a replayed browser stream replaced by a new one before its ready', () => {
    const { registry, sent } = createRegistry()
    registry.subscribe('browser.screencast', { page: 'page-1' }, () => {})
    const replayedId = sent[0]!.id
    registry.handleResponse(
      streamingResponse(replayedId, { type: 'ready', subscriptionId: 'page-1-old-connection' })
    )

    registry.markForReplay()
    registry.replayAfterAuthentication()
    registry.subscribe('browser.screencast', { page: 'page-2' }, () => {})
    const replacementId = sent.at(-1)!.id
    registry.handleResponse(
      streamingResponse(replayedId, { type: 'ready', subscriptionId: 'page-1-new-connection' })
    )
    registry.handleResponse(
      streamingResponse(replacementId, { type: 'ready', subscriptionId: 'page-2' })
    )

    expect(
      sent
        .filter((request) => request.method === 'browser.screencast.unsubscribe')
        .map((request) => request.params)
    ).toEqual([{ subscriptionId: 'page-1-new-connection' }])
    expect(registry.size()).toBe(1)
  })

  describe.each([
    ['runtime.clientEvents.subscribe', 'runtime.clientEvents.unsubscribe', null],
    ['browser.screencast', 'browser.screencast.unsubscribe', { page: 'page-1' }]
  ])('%s ready id across a replay', (method, unsubscribeMethod, params) => {
    function unsubscribes(sent: SentRequest[]): unknown[] {
      return sent.filter((request) => request.method === unsubscribeMethod).map((r) => r.params)
    }

    function subscribeReady() {
      const harness = createRegistry()
      const dispose = harness.registry.subscribe(method, params, () => {})
      const requestId = harness.sent[0]!.id
      harness.registry.handleResponse(
        streamingResponse(requestId, { type: 'ready', subscriptionId: 'old-connection-id' })
      )
      return { ...harness, dispose, requestId }
    }

    it('releases the replayed registration when disposed before its new ready', () => {
      const { registry, sent, dispose, requestId } = subscribeReady()

      registry.markForReplay()
      registry.replayAfterAuthentication()
      dispose()
      registry.handleResponse(
        streamingResponse(requestId, { type: 'ready', subscriptionId: 'new-connection-id' })
      )

      expect(unsubscribes(sent)).toEqual([{ subscriptionId: 'new-connection-id' }])
    })

    it('forgets the previous connection id when marked for replay', () => {
      const { registry, sent, dispose } = subscribeReady()

      registry.markForReplay()
      dispose()

      // A disposal while disconnected has nothing to name on the next connection.
      expect(unsubscribes(sent)).toEqual([])
      expect(registry.size()).toBe(0)
    })

    it('still releases a stream cancelled before its first ready', () => {
      const { registry, sent } = createRegistry()
      const dispose = registry.subscribe(method, params, () => {})
      const requestId = sent[0]!.id

      dispose()
      expect(unsubscribes(sent)).toEqual([])
      registry.handleResponse(
        streamingResponse(requestId, { type: 'ready', subscriptionId: 'first-id' })
      )

      expect(unsubscribes(sent)).toEqual([{ subscriptionId: 'first-id' }])
      expect(registry.size()).toBe(0)
    })

    it('sends one unsubscribe however often the stream is disposed', () => {
      const { registry, sent, dispose, requestId } = subscribeReady()

      registry.markForReplay()
      registry.replayAfterAuthentication()
      dispose()
      dispose()
      registry.handleResponse(
        streamingResponse(requestId, { type: 'ready', subscriptionId: 'new-connection-id' })
      )
      dispose()

      expect(unsubscribes(sent)).toEqual([{ subscriptionId: 'new-connection-id' }])
      expect(registry.size()).toBe(0)
    })
  })
})
