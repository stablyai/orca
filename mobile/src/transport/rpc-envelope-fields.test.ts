import { describe, expect, it } from 'vitest'
import { MobileRelayRpcStreams } from './mobile-relay-rpc-streams'
import {
  DIRECT_WIRE_DEVICE_TOKEN,
  directWire,
  directWireRegistry,
  directWireTracker
} from './direct-rpc-wire-test-harness'
import {
  RPC_TRANSPORT_FIELDS,
  buildDirectRpcWireRequest,
  withRpcEnvelopeFields,
  type RpcRequestFrame
} from './rpc-envelope-fields'
import type { RpcResponse } from './types'

const ENVELOPE = { executionHost: 'runtime:a' }

function relayStreams() {
  const frames: RpcRequestFrame[] = []
  let counter = 0
  const streams = new MobileRelayRpcStreams({
    nextId: () => `relay-${++counter}`,
    sendFrame: (frame) => {
      frames.push(frame)
      return true
    },
    waitForConnected: async () => undefined
  })
  return { streams, frames }
}

function answered(id: string): RpcResponse {
  return { id, ok: true, result: null, _meta: { runtimeId: 'runtime-1' } }
}

function streaming(id: string, result: unknown): RpcResponse {
  return { id, ok: true, streaming: true, result, _meta: { runtimeId: 'runtime-1' } }
}

describe('withRpcEnvelopeFields', () => {
  const request = {
    id: 'rpc-1',
    deviceToken: DIRECT_WIRE_DEVICE_TOKEN,
    method: 'm',
    params: { a: 1 }
  }

  it('hands back the request itself when there is nothing to merge', () => {
    expect(withRpcEnvelopeFields(request, undefined)).toBe(request)
    expect(withRpcEnvelopeFields(request, {})).toBe(request)
  })

  it('adds extra fields beside the transport ones', () => {
    expect(withRpcEnvelopeFields(request, { executionHost: 'runtime:a', n: [1, null] })).toEqual({
      ...request,
      executionHost: 'runtime:a',
      n: [1, null]
    })
  })

  it.each(RPC_TRANSPORT_FIELDS)('never lets the envelope set %s', (field) => {
    const merged = withRpcEnvelopeFields(request, { [field]: 'forged' })
    expect(merged).toEqual(request)
  })

  it('cannot fill in a transport field the request left out', () => {
    const { params: _omitted, ...bare } = request
    expect(JSON.stringify(withRpcEnvelopeFields(bare, { params: 'forged', x: 1 }))).toBe(
      JSON.stringify({ x: 1, ...bare })
    )
  })
})

describe('direct transport envelope', () => {
  it('sends a request with no envelope byte for byte as before', async () => {
    const socket = directWire()
    const requests = directWireTracker(socket)
    const answer = requests.sendRequest('status.get', { a: 1 }, { timeoutMs: 1000 })
    await Promise.resolve()
    expect(socket.sent).toEqual([
      '{"id":"rpc-1","deviceToken":"device-token","method":"status.get","params":{"a":1}}'
    ])
    requests.resolve(answered('rpc-1'))
    await answer
  })

  it('writes a frame without params, like the liveness probe, as before', () => {
    expect(
      JSON.stringify(
        buildDirectRpcWireRequest({ id: 'p-1', method: 'status.get' }, DIRECT_WIRE_DEVICE_TOKEN)
      )
    ).toBe('{"id":"p-1","deviceToken":"device-token","method":"status.get"}')
  })

  it('merges a request envelope under every transport field', async () => {
    const socket = directWire()
    const forged = Object.fromEntries(RPC_TRANSPORT_FIELDS.map((field) => [field, 'forged']))
    const requests = directWireTracker(socket)
    const answer = requests.sendRequest(
      'status.get',
      { a: 1 },
      { envelope: { ...forged, ...ENVELOPE } }
    )
    await Promise.resolve()
    expect(socket.frames()).toEqual([
      {
        id: 'rpc-1',
        deviceToken: DIRECT_WIRE_DEVICE_TOKEN,
        method: 'status.get',
        params: { a: 1 },
        ...ENVELOPE
      }
    ])
    requests.resolve(answered('rpc-1'))
    await answer
  })

  it('sends a subscribe with no envelope byte for byte as before', () => {
    const socket = directWire()
    directWireRegistry(socket).subscribe('terminal.subscribe', { terminal: 't1' }, () => undefined)
    expect(socket.sent).toEqual([
      '{"id":"rpc-1","deviceToken":"device-token","method":"terminal.subscribe","params":{"terminal":"t1"}}'
    ])
  })

  it('keeps a stream envelope on its subscribe, its replay and its unsubscribe', () => {
    const socket = directWire()
    const streams = directWireRegistry(socket)
    const dispose = streams.subscribe('terminal.subscribe', { terminal: 't1' }, () => undefined, {
      envelope: { ...ENVELOPE, id: 'forged' }
    })
    streams.markForReplay()
    streams.replayAfterAuthentication()
    dispose()
    expect(socket.frames().map((frame) => [frame.method, frame.executionHost, frame.id])).toEqual([
      ['terminal.subscribe', 'runtime:a', 'rpc-1'],
      ['terminal.subscribe', 'runtime:a', 'rpc-1'],
      ['terminal.unsubscribe', 'runtime:a', 'rpc-2']
    ])
  })

  it('keeps it on the unsubscribe a ready id sends after the stream was disposed', () => {
    const socket = directWire()
    const streams = directWireRegistry(socket)
    const dispose = streams.subscribe('runtime.clientEvents.subscribe', {}, () => undefined, {
      envelope: ENVELOPE
    })
    dispose()
    streams.handleResponse(streaming('rpc-1', { type: 'ready', subscriptionId: 'server-1' }))
    expect(socket.frames().at(-1)).toMatchObject({
      method: 'runtime.clientEvents.unsubscribe',
      params: { subscriptionId: 'server-1' },
      ...ENVELOPE
    })
  })

  it('keeps it on the unsubscribe for a browser ready that no longer owns the screencast', () => {
    const socket = directWire()
    const streams = directWireRegistry(socket)
    streams.subscribe('browser.screencast', { page: 'p' }, () => undefined, { envelope: ENVELOPE })
    streams.markForReplay()
    streams.handleResponse(streaming('rpc-1', { type: 'ready', subscriptionId: 'stale' }))
    expect(socket.frames().at(-1)).toMatchObject({
      method: 'browser.screencast.unsubscribe',
      params: { subscriptionId: 'stale' },
      ...ENVELOPE
    })
  })
})

describe('relay transport envelope', () => {
  it('keeps it on a session tabs unsubscribe deferred until the snapshot', async () => {
    const { streams, frames } = relayStreams()
    const dispose = streams.subscribe('session.tabs.subscribe', { worktree: 'w' }, () => {}, {
      envelope: ENVELOPE
    })
    await Promise.resolve()
    dispose()
    expect(frames).toHaveLength(1)
    streams.handleResponse(streaming(frames[0]!.id, { type: 'snapshot', tabs: [] }))
    expect(frames.at(-1)).toMatchObject({
      method: 'session.tabs.unsubscribe',
      params: { worktree: 'w', subscriptionId: 'relay-1' },
      envelope: ENVELOPE
    })
  })

  it('keeps it on a ready-id unsubscribe deferred until the ready', async () => {
    const { streams, frames } = relayStreams()
    const dispose = streams.subscribe('runtime.clientEvents.subscribe', {}, () => {}, {
      envelope: ENVELOPE
    })
    await Promise.resolve()
    dispose()
    expect(frames).toHaveLength(1)
    streams.handleResponse(streaming(frames[0]!.id, { type: 'ready', subscriptionId: 'server-1' }))
    expect(frames.at(-1)).toMatchObject({
      method: 'runtime.clientEvents.unsubscribe',
      params: { subscriptionId: 'server-1' },
      envelope: ENVELOPE
    })
  })
})
