import { describe, expect, it, vi } from 'vitest'
import { RpcClientStreamRegistry } from './rpc-client-stream-registry'
import { MobileRelayRpcStreams } from './mobile-relay-rpc-streams'
import { MobileWsInboundMessageQueue } from './mobile-ws-inbound-message-queue'
import {
  decodeTerminalStreamFrame,
  encodeTerminalStreamFrame,
  encodeTerminalStreamText,
  TerminalStreamOpcode
} from '../../../src/shared/terminal-stream-protocol'
import type { RpcRequestFrame } from './rpc-envelope-fields'
import type { RpcResponse } from './types'

const params = {
  terminal: 't1',
  client: { id: 'phone', type: 'mobile' },
  capabilities: { terminalBinaryStream: 1, ackOutput: 1 }
}

function response(id: string, result: unknown): RpcResponse {
  return { id, ok: true, streaming: true, result, _meta: { runtimeId: 'host' } }
}

describe.each(['direct', 'relay'] as const)('%s terminal credit compatibility', (path) => {
  function connection() {
    let nextId = 0
    const sent: RpcRequestFrame[] = []
    const binary: Uint8Array[] = []
    const options = {
      nextId: () => String(++nextId),
      getState: () => 'connected' as const,
      waitForConnected: () => Promise.resolve(),
      sendFrame: (frame: RpcRequestFrame) => {
        sent.push(frame)
        return true
      },
      sendBinary: (bytes: Uint8Array) => {
        binary.push(bytes)
        return true
      }
    }
    const streams =
      path === 'direct' ? new RpcClientStreamRegistry(options) : new MobileRelayRpcStreams(options)
    return { streams, sent, binary }
  }

  it.each(['legacy-ready', 'unknown-method'])(
    'recovers exact legacy output after %s',
    async (host) => {
      const { streams, sent, binary } = connection()
      const events: unknown[] = []
      const stop = streams.subscribe('terminal.subscribe', params, (event) => {
        events.push(event)
        return Promise.resolve()
      })
      await vi.waitFor(() => expect(sent).toHaveLength(1))
      streams.handleResponse(
        host === 'legacy-ready'
          ? response(sent[0]!.id, { type: 'ready' })
          : {
              id: sent[0]!.id,
              ok: false,
              error: { code: 'unknown_method', message: 'Unknown method' },
              _meta: { runtimeId: 'host' }
            }
      )
      await vi.waitFor(() =>
        expect(sent.some((frame) => frame.method === 'terminal.subscribe')).toBe(true)
      )
      const legacy = sent.find((frame) => frame.method === 'terminal.subscribe')!
      streams.handleResponse(response(legacy.id, { type: 'subscribed', streamId: 7 }))
      streams.handleBinary(
        encodeTerminalStreamFrame({
          streamId: 7,
          opcode: TerminalStreamOpcode.Output,
          seq: 1,
          payload: encodeTerminalStreamText('exact\x1b[31m')
        })
      )
      await Promise.resolve()
      expect(events).toContainEqual({ type: 'data', streamId: 7, chunk: 'exact\x1b[31m' })
      expect(binary).toHaveLength(0)
      stop()
    }
  )

  it('never grants a retired stream credit when its parser finishes after replacement', async () => {
    const { streams, sent, binary } = connection()
    let apply = () => {}
    const stop = streams.subscribe(
      'terminal.subscribe',
      params,
      () =>
        new Promise<void>((resolve) => {
          apply = resolve
        })
    )
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    streams.handleResponse(
      response(sent[0]!.id, { type: 'ready', capabilities: { mobileTerminalOutputCredits: 1 } })
    )
    const subscribed = decodeTerminalStreamFrame(binary[0]!)!
    const decoded: { streamId: number } = JSON.parse(new TextDecoder().decode(subscribed.payload))
    const id = decoded.streamId
    streams.handleBinary(
      encodeTerminalStreamFrame({
        streamId: id,
        opcode: TerminalStreamOpcode.Output,
        seq: 1,
        payload: encodeTerminalStreamText('held')
      })
    )
    stop()
    const stopReplacement = streams.subscribe('terminal.subscribe', params, () => Promise.resolve())
    apply()
    await Promise.resolve()
    expect(
      binary
        .map(decodeTerminalStreamFrame)
        .filter((frame) => frame?.opcode === TerminalStreamOpcode.Ack)
    ).toEqual([])
    stopReplacement()
  })

  it('applies a large unbudgeted snapshot as one bounded application event', async () => {
    const { streams, sent, binary } = connection()
    const events: unknown[] = []
    let applied = () => {}
    const stop = streams.subscribe('terminal.subscribe', params, (event) => {
      events.push(event)
      return new Promise<void>((resolve) => {
        applied = resolve
      })
    })
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    streams.handleResponse(
      response(sent[0]!.id, { type: 'ready', capabilities: { mobileTerminalOutputCredits: 1 } })
    )
    const id = JSON.parse(
      new TextDecoder().decode(decodeTerminalStreamFrame(binary[0]!)!.payload)
    ).streamId
    const deliver = (opcode: TerminalStreamOpcode, text: string) =>
      streams.handleBinary(
        encodeTerminalStreamFrame({
          streamId: id,
          opcode,
          seq: 0,
          payload: encodeTerminalStreamText(text)
        })
      )
    deliver(TerminalStreamOpcode.SnapshotStart, '{}')
    const chunk = 'x'.repeat(48 * 1024)
    for (let i = 0; i < 260; i++) {
      deliver(TerminalStreamOpcode.SnapshotChunk, chunk)
    }
    deliver(TerminalStreamOpcode.SnapshotEnd, '')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'scrollback' })
    const event = events[0]
    expect(
      typeof event === 'object' &&
        event !== null &&
        'serialized' in event &&
        event.serialized === chunk.repeat(260)
    ).toBe(true)
    expect(
      binary
        .map(decodeTerminalStreamFrame)
        .filter((frame) => frame?.opcode === TerminalStreamOpcode.Ack)
    ).toEqual([])
    applied()
    await Promise.resolve()
    stop()
  })
})

it.each([1, 10])('bounds raw conversions across %sx retired physical connections', async (load) => {
  let release = () => {}
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  let started = 0
  const pending: Promise<void>[] = []
  const payload = new Uint8Array(8 * 1024 * 1024)
  try {
    for (let i = 0; i < 8 * load; i++) {
      const queue = new MobileWsInboundMessageQueue(
        async () => {
          started++
          await blocked
        },
        () => {}
      )
      pending.push(queue.enqueue(payload))
      await Promise.resolve()
      queue.dispose()
    }
    expect(started).toBe(4)
  } finally {
    release()
    await Promise.all(pending)
  }
})
