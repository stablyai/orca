import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RelayDispatcher, type RequestContext, type SinkWriteSettlement } from './dispatcher'
import { RelayNetworkTunnelRegistry } from './relay-network-tunnel-registry'
import type { BrowserNetworkTunnelSocket } from '../main/browser/browser-network-tunnel-stream-state'
import {
  encodeRelayNetworkTunnelFrame,
  type RelayNetworkTunnelHandle
} from '../shared/relay-network-tunnel-contract'
import {
  BrowserNetworkTunnelOpcode as Op,
  encodeBrowserNetworkTunnelFrame,
  encodeBrowserNetworkTunnelOpen
} from '../shared/browser-network-tunnel-protocol'

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const dispose of cleanup.splice(0)) {
    dispose()
  }
})

function fixture(autoWrite = true) {
  const writes: ((result: SinkWriteSettlement) => void)[] = []
  const dispatcher = new RelayDispatcher(
    (_data, settle) => {
      writes.push(settle)
      if (autoWrite) {
        settle({ ok: true })
      }
      return true
    },
    { supportsWriteCallback: true }
  )
  const owner = { ownerGeneration: 1, ownerLease: 'lease' }
  const request = { version: 1 as const, runtimeIncarnation: 'runtime', ...owner }
  const owners = { activeSessionOwner: vi.fn(() => owner), assertOwnerPublicationSettled: vi.fn() }
  const socket = Object.assign(new EventEmitter(), {
    destroyed: false,
    setNoDelay: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    end: vi.fn(),
    write: vi.fn((_bytes, callback) => {
      callback?.()
      return true
    }),
    destroy: vi.fn(() => {
      socket.destroyed = true
      return socket
    })
  })
  const connect = vi.fn(() => socket as unknown as BrowserNetworkTunnelSocket)
  const registry = new RelayNetworkTunnelRegistry({
    dispatcher,
    owners,
    runtimeIncarnation: 'runtime',
    ownsEndpoint: () => true,
    connect
  })
  cleanup.push(() => {
    registry.dispose()
    dispatcher.dispose()
    socket.emit('close')
  })
  let settleOpen: (result: SinkWriteSettlement) => void = () => {
    throw new Error('no open')
  }
  const context: RequestContext = {
    clientId: 1,
    transportGeneration: 0,
    isStale: () => false,
    sessionIdentity: {
      principal: 'principal',
      authenticated: true,
      allowSessionOwner: true,
      authenticationKind: 'endpoint-credential'
    },
    onResponseSettled: (callback) => {
      settleOpen = callback
    }
  }
  const open = () => {
    const handle = registry.open(request, context)
    settleOpen({ ok: true })
    return handle
  }
  const send = (handle: RelayNetworkTunnelHandle, opcode: Op, streamId = 1) => {
    const bytes = encodeBrowserNetworkTunnelFrame({
      opcode,
      tunnelGeneration: handle.tunnelGeneration,
      streamId,
      payload:
        opcode === Op.Open
          ? encodeBrowserNetworkTunnelOpen({ host: 'host.internal', port: 443 })
          : new Uint8Array()
    })
    registry.handleFrame(encodeRelayNetworkTunnelFrame(handle, bytes), context)
  }
  return {
    registry,
    dispatcher,
    owner,
    owners,
    socket,
    connect,
    context,
    request,
    writes,
    open,
    send,
    settleOpen: (result: SinkWriteSettlement) => settleOpen(result)
  }
}

describe('relay network tunnel registry', () => {
  it('waits for opening reply settlement before accepting stream traffic', () => {
    const f = fixture()
    const handle = f.registry.open(f.request, f.context)
    expect(() => f.send(handle, Op.Open)).toThrow('open_publication_pending')
    expect(f.connect).not.toHaveBeenCalled()
    f.settleOpen({ ok: true })
    f.send(handle, Op.Open)
    expect(f.connect).toHaveBeenCalledExactlyOnceWith({ host: 'host.internal', port: 443 })
  })

  it('includes pending opening replies in reset drain', async () => {
    const f = fixture()
    f.registry.open(f.request, f.context)
    const fence = f.registry.fenceForDrain()
    const done = vi.fn()
    const drain = fence.drain(new AbortController().signal).then(done)
    await Promise.resolve()
    expect(done).not.toHaveBeenCalled()
    f.settleOpen({ ok: true })
    await drain
  })

  it('fences new tunnels and inner opens while preserving admitted sockets and final writes', async () => {
    const f = fixture(false)
    const handle = f.open()
    f.send(handle, Op.Open)
    const fence = f.registry.fenceForDrain()
    expect(() => f.registry.open(f.request, f.context)).toThrow('admission_closed')
    f.send(handle, Op.Open, 2)
    expect(f.connect).toHaveBeenCalledTimes(1)
    expect(f.socket.destroy).not.toHaveBeenCalled()
    f.socket.emit('connect')
    f.socket.emit('end')
    f.socket.emit('close')
    const done = vi.fn()
    const drain = fence.drain(new AbortController().signal).then(done)
    await Promise.resolve()
    expect(done).not.toHaveBeenCalled()
    for (const settle of f.writes) {
      settle({ ok: true })
    }
    await drain
    expect(() => fence.assertDrained()).not.toThrow()
  })

  it('rejects an unrelated principal without opening a host socket', () => {
    const f = fixture()
    const handle = f.open()
    const bytes = encodeBrowserNetworkTunnelFrame({
      opcode: Op.Open,
      tunnelGeneration: handle.tunnelGeneration,
      streamId: 1,
      payload: encodeBrowserNetworkTunnelOpen({ host: 'host', port: 80 })
    })
    expect(() =>
      f.registry.handleFrame(encodeRelayNetworkTunnelFrame(handle, bytes), {
        ...f.context,
        sessionIdentity: { ...f.context.sessionIdentity!, principal: 'intruder' }
      })
    ).toThrow('unauthorized')
    expect(f.connect).not.toHaveBeenCalled()
  })

  it.each(['owner', 'incarnation', 'authentication', 'unsettled-owner'] as const)(
    'refuses %s mismatch',
    (kind) => {
      const f = fixture()
      if (kind === 'owner') {
        f.owner.ownerGeneration++
      }
      if (kind === 'incarnation') {
        f.request.runtimeIncarnation = 'other'
      }
      if (kind === 'authentication') {
        f.context.sessionIdentity!.authenticated = false
      }
      if (kind === 'unsettled-owner') {
        f.owners.assertOwnerPublicationSettled.mockImplementation(() => {
          throw new Error('owner pending')
        })
      }
      expect(() => f.registry.open(f.request, f.context)).toThrow()
      expect(f.connect).not.toHaveBeenCalled()
    }
  )

  it('refuses drain after idle primary transport replacement and closes only its tunnel sockets', async () => {
    const f = fixture()
    const handle = f.open()
    f.send(handle, Op.Open)
    const fence = f.registry.fenceForDrain()
    const drain = fence.drain(new AbortController().signal)
    f.dispatcher.setWrite(() => true, { supportsWriteCallback: true })
    await expect(drain).rejects.toThrow()
    expect(f.socket.destroy).toHaveBeenCalled()
    expect(() => fence.assertDrained()).toThrow()
  })

  it('retains opening response failure before reset', () => {
    const f = fixture()
    f.registry.open(f.request, f.context)
    f.settleOpen({ ok: false, error: new Error('open reply lost') })
    expect(() => f.registry.fenceForDrain()).toThrow('open reply lost')
  })

  it('reuses capacity only after proven close and never reuses generation', async () => {
    const f = fixture()
    const first = f.open()
    await f.registry.close(first, f.context)
    const second = f.open()
    expect(second.tunnelGeneration).toBeGreaterThan(first.tunnelGeneration)
    expect(() => f.send(first, Op.Open)).toThrow('handle_mismatch')
  })

  it('keeps other tunnels usable after a failure and fences their opens before refusing reset', () => {
    const f = fixture()
    const first = f.open()
    const second = f.open()
    f.send(first, Op.Opened)
    f.send(second, Op.Open)
    expect(f.connect).toHaveBeenCalledTimes(1)
    expect(() => f.registry.fenceForDrain()).toThrow('closed_unproven')
    f.send(second, Op.Open, 2)
    expect(f.connect).toHaveBeenCalledTimes(1)
    expect(f.socket.destroy).not.toHaveBeenCalled()
  })

  it('seals proven drain against late heartbeats and retains identity checks on retry', async () => {
    const f = fixture()
    const handle = f.open()
    const fence = f.registry.fenceForDrain()
    await fence.drain(new AbortController().signal)
    fence.seal()
    expect(() => f.send(handle, Op.Ping, 0)).toThrow('shutdown_sealed')
    expect(f.writes).toHaveLength(0)
    expect(f.registry.fenceForDrain()).toBe(fence)
    await fence.drain(new AbortController().signal)
    f.dispatcher.setWrite(() => true, { supportsWriteCallback: true })
    expect(() => fence.assertDrained()).toThrow('transport_unverifiable')
  })
})
