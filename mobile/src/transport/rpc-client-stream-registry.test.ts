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
})
