import { describe, expect, it } from 'vitest'
import { RpcClientStreamRegistry } from './rpc-client-stream-registry'
import {
  encodeTerminalStreamFrame,
  TerminalStreamOpcode
} from '../../../src/shared/terminal/stream/terminal-stream-protocol'
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
    getState: () => state,
    sendFrame: (request) => {
      if (state !== 'connected') {
        return false
      }
      sent.push(request)
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
    registry.handleResponse(streamingResponse(first.id, { type: 'subscribed', streamId: 8 }))
    registry.handleBinary(terminalOutput(8, 'after'))
    registry.handleBinary(terminalOutput(7, 'still-stale'))

    expect(sent[1]).toMatchObject({
      id: first.id,
      method: 'terminal.subscribe',
      params: { terminal: 'term-1', viewport: { cols: 60, rows: 24 } }
    })
    expect(events).toEqual([
      { type: 'subscribed', streamId: 7 },
      { type: 'data', streamId: 7, chunk: 'before' },
      { type: 'subscribed', streamId: 8 },
      { type: 'data', streamId: 8, chunk: 'after' }
    ])
  })

  it('re-sends a stream its owner holds only when the owner resends it, and a cancel before then sends nothing', () => {
    const { registry, sent } = createRegistry()
    const held: (() => void)[] = []
    const holdReplay = (resend: () => void) => held.push(resend) > 0
    const cancel = registry.subscribe('terminal.subscribe', { terminal: 'term-1' }, () => {}, {
      holdReplay
    })
    registry.subscribe('terminal.subscribe', { terminal: 'term-2' }, () => {}, { holdReplay })

    registry.markForReplay()
    registry.replayAfterAuthentication()
    expect(sent).toHaveLength(2)

    cancel()
    held.forEach((resend) => resend())
    expect(sent.slice(2)).toEqual([
      expect.objectContaining({ method: 'terminal.subscribe', params: { terminal: 'term-2' } })
    ])
  })

  it('holds a session tabs unsubscribe until the host registers the stream', () => {
    const { registry, sent } = createRegistry()
    const events: unknown[] = []
    const dispose = registry.subscribe('session.tabs.subscribe', { worktree: 'wt-1' }, (event) =>
      events.push(event)
    )
    const subscribe = sent[0]!

    dispose()
    // Older hosts register only as they emit the first snapshot, so an earlier unsubscribe finds nothing.
    expect(sent).toHaveLength(1)

    registry.handleResponse(streamingResponse(subscribe.id, { type: 'snapshot', tabs: [] }))

    expect(sent[1]).toMatchObject({
      method: 'session.tabs.unsubscribe',
      params: { worktree: 'wt-1', subscriptionId: subscribe.id }
    })
    // A host that registered on arrival ends the stream; that end must not unsubscribe again.
    registry.handleResponse(streamingResponse(subscribe.id, { type: 'end' }))
    expect(sent).toHaveLength(2)
    expect(events).toEqual([])
    expect(registry.size()).toBe(0)
  })

  it('ends one transcript stream on dispose and leaves a sibling on the same socket (U-03)', () => {
    const { registry, sent } = createRegistry()
    const disposeFirst = registry.subscribe('agentSession.subscribe', { sessionId: 's1' }, () => {})
    const siblingEvents: unknown[] = []
    registry.subscribe('agentSession.subscribe', { sessionId: 's2' }, (event) =>
      siblingEvents.push(event)
    )
    const [first, sibling] = sent

    disposeFirst()
    expect(sent.at(-1)).toMatchObject({
      method: 'agentSession.unsubscribe',
      params: { sessionId: 's1', subscriptionId: first!.id }
    })
    expect(sent.filter((request) => request.method === 'agentSession.unsubscribe')).toHaveLength(1)
    registry.handleResponse(streamingResponse(sibling!.id, { type: 'chunk', text: 'still active' }))
    expect(siblingEvents).toEqual([{ type: 'chunk', text: 'still active' }])
    expect(registry.size()).toBe(1)
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
})
