import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { RelayDispatcher } from './dispatcher'
import { RelayGraceLifecycle } from './relay-grace-lifecycle'
import { RelayNetworkTunnelRegistry } from './relay-network-tunnel-registry'
import { registerRelayNetworkTunnels } from './relay-network-tunnel-registration'
import type { PtyHandler } from './pty-handler'
import type { BrowserNetworkTunnelSocket } from '../main/browser/browser-network-tunnel-stream-state'
import { encodeJsonRpcFrame } from './protocol'
import {
  RELAY_NETWORK_TUNNEL_CAPABILITY,
  RELAY_NETWORK_TUNNEL_OPEN_METHOD,
  RELAY_NETWORK_TUNNEL_FRAME_METHOD,
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

function fixture() {
  const messages: {
    id?: number
    result?: RelayNetworkTunnelHandle
    error?: { message: string }
  }[] = []
  const dispatcher = new RelayDispatcher(
    (bytes, settle) => {
      messages.push(JSON.parse(bytes.subarray(13).toString()))
      settle({ ok: true })
      return true
    },
    { supportsWriteCallback: true },
    {
      principal: 'owner',
      authenticated: true,
      allowSessionOwner: true,
      authenticationKind: 'endpoint-credential'
    }
  )
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
  const owner = { ownerGeneration: 1, ownerLease: 'lease' }
  const ownsEndpoint = vi.fn(() => true)
  const registry = new RelayNetworkTunnelRegistry({
    dispatcher,
    runtimeIncarnation: 'runtime',
    ownsEndpoint,
    connect,
    owners: { activeSessionOwner: () => owner, assertOwnerPublicationSettled: () => {} }
  })
  const status = registerRelayNetworkTunnels(dispatcher, registry, 'runtime', ownsEndpoint)
  const fenceCreationForShutdown = vi.fn()
  const dispose = vi.fn(async () => {})
  const disposeOwnedProcesses = vi.fn(async () => {})
  const lifecycle = new RelayGraceLifecycle({
    dispatcher,
    ptyHandler: {
      activePtyCount: 0,
      pendingPtyCreationCount: 0,
      hasLiveOwnershipTransferFence: false,
      setOwnershipTransferGraceGuardEnabled: vi.fn(),
      cancelGraceTimer: vi.fn(),
      fenceCreationForShutdown,
      dispose
    } as unknown as PtyHandler,
    detached: true,
    emptyDetachedStartupGraceMs: 100,
    idleRelayGraceMs: 100,
    readSocketClientCount: () => 1,
    hasAcceptedSocketClient: () => true,
    ownsSocketPath: () => true,
    disposeOwnedProcesses,
    disposeRuntime: vi.fn(),
    fenceNetworkTunnels: () => registry.fenceForDrain(),
    hasNetworkTunnels: () => registry.hasTunnels
  })
  cleanup.push(() => {
    registry.dispose()
    dispatcher.dispose()
    socket.emit('close')
  })
  let sequence = 0
  const send = (method: string, params: Record<string, unknown>, id?: number) =>
    dispatcher.feed(
      encodeJsonRpcFrame(
        { jsonrpc: '2.0', method, params, ...(id === undefined ? {} : { id }) },
        ++sequence,
        0
      )
    )
  const open = async () => {
    send(
      RELAY_NETWORK_TUNNEL_OPEN_METHOD,
      { version: 1, runtimeIncarnation: 'runtime', ...owner },
      1
    )
    await vi.waitFor(() => expect(messages.find((m) => m.id === 1)?.result).toBeDefined())
    return messages.find((m) => m.id === 1)!.result!
  }
  const frame = (handle: RelayNetworkTunnelHandle, opcode: Op, streamId = 1) =>
    send(
      RELAY_NETWORK_TUNNEL_FRAME_METHOD,
      encodeRelayNetworkTunnelFrame(
        handle,
        encodeBrowserNetworkTunnelFrame({
          opcode,
          streamId,
          tunnelGeneration: handle.tunnelGeneration,
          payload:
            opcode === Op.Open
              ? encodeBrowserNetworkTunnelOpen({ host: 'server', port: 8080 })
              : new Uint8Array()
        })
      )
    )
  return {
    registry,
    dispatcher,
    lifecycle,
    socket,
    connect,
    status,
    ownsEndpoint,
    open,
    frame,
    send,
    messages,
    dispose,
    disposeOwnedProcesses,
    fenceCreationForShutdown
  }
}

it('registers a capability only while owning the endpoint and admission remains open', async () => {
  const f = fixture()
  expect(f.status()).toEqual({
    capabilities: [RELAY_NETWORK_TUNNEL_CAPABILITY],
    networkTunnel: { version: 1, runtimeIncarnation: 'runtime' }
  })
  f.ownsEndpoint.mockReturnValue(false)
  expect(f.status()).toEqual({ capabilities: [] })
  f.ownsEndpoint.mockReturnValue(true)
  await f.open()
  f.registry.fenceForDrain()
  expect(f.status()).toEqual({ capabilities: [] })
})

it('drains real registered frame traffic before killing destination processes', async () => {
  const f = fixture()
  const handle = await f.open()
  f.frame(handle, Op.Open)
  f.socket.emit('connect')
  const preparation = f.lifecycle.prepareShutdown()
  expect(f.fenceCreationForShutdown).toHaveBeenCalledOnce()
  expect(f.dispose).not.toHaveBeenCalled()
  f.frame(handle, Op.Open, 2)
  expect(f.connect).toHaveBeenCalledTimes(1)
  f.send(RELAY_NETWORK_TUNNEL_OPEN_METHOD, handle, 2)
  await vi.waitFor(() =>
    expect(f.messages.find((m) => m.id === 2)?.error?.message).toBe('relay_work_admission_closed')
  )
  expect(f.disposeOwnedProcesses).not.toHaveBeenCalled()
  f.frame(handle, Op.HalfClose)
  expect(f.socket.end).toHaveBeenCalled()
  f.socket.emit('end')
  f.socket.emit('close')
  await preparation
  expect(f.dispose).toHaveBeenCalledOnce()
  expect(f.disposeOwnedProcesses).toHaveBeenCalledOnce()
})

it('does not kill destination processes when tunnel drain becomes unverifiable', async () => {
  const f = fixture()
  const handle = await f.open()
  f.frame(handle, Op.Open)
  const preparation = f.lifecycle.prepareShutdown()
  f.dispatcher.setWrite(() => true, { supportsWriteCallback: true })
  await expect(preparation).rejects.toThrow()
  expect(f.dispose).not.toHaveBeenCalled()
  expect(f.disposeOwnedProcesses).not.toHaveBeenCalled()
  expect(() => f.lifecycle.finishShutdown()).toThrow('preparation_required')
})
