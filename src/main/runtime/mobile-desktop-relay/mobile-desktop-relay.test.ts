import { describe, expect, it, vi } from 'vitest'
import { DELEGATED_MOBILE_DEVICES_RUNTIME_CAPABILITY } from '../../../shared/delegated-mobile-device-contract'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import { RemoteRuntimeClientError } from '../../../shared/remote-runtime-client-error'
import type { RemoteRuntimePassthroughCallbacks } from '../../../shared/remote-runtime-passthrough-socket'
import { MobileDesktopRelay, type RelayedPhone } from './mobile-desktop-relay'
import type { MobileDesktopRelayHosts } from './mobile-desktop-relay-hosts'

type FakeSocket = {
  sent: string[]
  capabilities: readonly string[]
  callbacks: RemoteRuntimePassthroughCallbacks
  closed: boolean
  accepts: boolean
}
const sockets = vi.hoisted(() => {
  const opened: FakeSocket[] = []
  return opened
})
// Holds every socket open until released, so a test can act while one is still connecting.
const openGate = vi.hoisted(() => ({ wait: Promise.resolve() }))
vi.mock('../../../shared/remote-runtime-passthrough-socket', () => ({
  openRemoteRuntimePassthroughSocket: async (
    _pairing: unknown,
    capabilities: readonly string[],
    callbacks: RemoteRuntimePassthroughCallbacks
  ) => {
    const socket: FakeSocket = { sent: [], capabilities, callbacks, closed: false, accepts: true }
    sockets.push(socket)
    await openGate.wait
    return {
      send: (frame: string) => {
        socket.sent.push(frame)
        return socket.accepts
      },
      close: () => {
        socket.closed = true
      }
    }
  }
}))

const ok = (result: unknown) => ({ id: 'x', ok: true as const, result, _meta: { runtimeId: 'h' } })

const SYNCED = ok({
  devices: [
    { phoneKey: 'phone-1', deviceId: 'child', token: 'host-token' },
    { phoneKey: 'phone-2', deviceId: 'child-2', token: 'host-token-2' }
  ]
})

function relayWithPhone(
  syncResponse: () => RuntimeRpcResponse<unknown> | Promise<RuntimeRpcResponse<unknown>> = () =>
    SYNCED
) {
  const syncCalls: unknown[] = []
  const server = { capable: true }
  const hosts: MobileDesktopRelayHosts = {
    list: () => ({
      environments: [],
      statusByEnvironmentId: new Map(),
      sshTargetLabels: new Map(),
      sshConnectionStates: new Map()
    }),
    resolve: async (environmentId) => ({
      environmentId,
      fence: 'f',
      pairing: { v: 2, endpoint: 'ws://127.0.0.1:1', deviceToken: 'desktop', publicKeyB64: 'k' }
    }),
    call: async (_host, method, params) => {
      if (method === 'status.get') {
        return ok({
          capabilities: server.capable ? [DELEGATED_MOBILE_DEVICES_RUNTIME_CAPABILITY] : []
        })
      }
      syncCalls.push(params)
      return syncResponse()
    },
    onEnvironmentRetired: () => () => {}
  }
  const relay = new MobileDesktopRelay({
    hosts,
    listPhones: () => [
      { phoneKey: 'phone-1', name: 'iPhone via Mac' },
      { phoneKey: 'phone-2', name: 'iPad via Mac' }
    ],
    allocateStreamId: () => 1
  })
  const replies: string[] = []
  let capabilities: readonly string[] = ['cap.a']
  const phone: RelayedPhone = {
    connectionId: 'conn-1',
    deviceId: 'phone-1',
    deviceToken: 'desktop-token',
    clientCapabilities: () => capabilities,
    reply: (frame) => replies.push(frame),
    sendBinary: () => true
  }
  return {
    relay,
    phone,
    replies,
    syncCalls,
    server,
    setCapabilities: (next: string[]) => (capabilities = next)
  }
}

describe('MobileDesktopRelay', () => {
  it('signs in with exactly the phone capabilities and mirrors its updates without a second answer', async () => {
    sockets.length = 0
    const { relay, phone, replies, setCapabilities } = relayWithPhone()
    relay.forward(
      phone,
      'env-1',
      { id: 'r1', method: 'terminal.list' },
      '{"id":"r1","method":"terminal.list"}'
    )
    relay.forward(
      phone,
      'env-2',
      { id: 'r2', method: 'terminal.list' },
      '{"id":"r2","method":"terminal.list"}'
    )
    await vi.waitFor(() => expect(sockets.map((socket) => socket.sent.length)).toEqual([1, 1]))
    expect(sockets[0]!.capabilities).toEqual(['cap.a'])

    setCapabilities(['cap.b'])
    const update = JSON.stringify({
      id: 'caps',
      deviceToken: 'desktop-token',
      method: 'runtime.clientCapabilities.update',
      params: { clientCapabilities: ['cap.b'] }
    })
    relay.forwardClientCapabilities('conn-1', update)
    relay.forwardClientCapabilities('other-connection', update)
    await vi.waitFor(() => expect(sockets.map((socket) => socket.sent.length)).toEqual([2, 2]))
    for (const socket of sockets) {
      const mirrored = JSON.parse(socket.sent[1]!)
      expect(mirrored).toMatchObject({
        method: 'runtime.clientCapabilities.update',
        params: { clientCapabilities: ['cap.b'] }
      })
      expect(mirrored.id).not.toBe('caps')
      expect(mirrored.deviceToken).toBeUndefined()
      // The host's answer to the mirror is the relay's, not the phone's.
      socket.callbacks.onText(JSON.stringify({ id: mirrored.id, ok: true, result: {}, _meta: {} }))
    }
    expect(replies).toEqual([])
  })

  it('answers every request still open when the server socket drops, then closes on phone disconnect', async () => {
    sockets.length = 0
    const { relay, phone, replies } = relayWithPhone()
    relay.forward(phone, 'env-1', { id: 'a', method: 'terminal.list' }, '{"id":"a"}')
    relay.forward(phone, 'env-1', { id: 'b', method: 'terminal.list' }, '{"id":"b"}')
    await vi.waitFor(() => expect(sockets[0]?.sent).toHaveLength(2))
    // One socket per (phone connection, server) carries both requests.
    expect(sockets).toHaveLength(1)
    sockets[0]!.callbacks.onText('{"id":"a","ok":true,"result":{},"_meta":{"runtimeId":"h"}}')
    sockets[0]!.callbacks.onClose(
      new RemoteRuntimeClientError('remote_runtime_unavailable', 'gone')
    )
    expect(replies.map((frame) => JSON.parse(frame))).toEqual([
      { id: 'a', ok: true, result: {}, _meta: { runtimeId: 'h' } },
      expect.objectContaining({
        id: 'b',
        ok: false,
        error: expect.objectContaining({ code: 'remote_runtime_unavailable' })
      })
    ])

    relay.forward(phone, 'env-1', { id: 'c', method: 'terminal.list' }, '{"id":"c"}')
    await vi.waitFor(() => expect(sockets).toHaveLength(2))
    relay.closePhoneConnection('conn-1')
    await vi.waitFor(() => expect(sockets[1]!.closed).toBe(true))
  })

  it('treats a server whose sync failed as unavailable, and syncs again on the next request', async () => {
    sockets.length = 0
    let failing = true
    const { relay, phone, replies } = relayWithPhone(() =>
      failing
        ? {
            id: 'x',
            ok: false,
            error: { code: 'runtime_error', message: 'delegated_device_revoke_failed' }
          }
        : ok({ devices: [{ phoneKey: 'phone-1', deviceId: 'child', token: 'host-token' }] })
    )
    relay.forward(phone, 'env-1', { id: 'a', method: 'terminal.list' }, '{"id":"a"}')
    await vi.waitFor(() => expect(replies).toHaveLength(1))
    expect(JSON.parse(replies[0]!)).toMatchObject({
      id: 'a',
      error: { code: 'remote_runtime_unavailable' }
    })
    expect(sockets).toHaveLength(0)

    failing = false
    relay.forward(phone, 'env-1', { id: 'b', method: 'terminal.list' }, '{"id":"b"}')
    await vi.waitFor(() => expect(sockets[0]?.sent).toHaveLength(1))
  })

  it('runs one sync when two phones race to the same server', async () => {
    sockets.length = 0
    const { relay, phone, syncCalls } = relayWithPhone()
    const tablet: RelayedPhone = { ...phone, connectionId: 'conn-2', deviceId: 'phone-2' }
    relay.forward(phone, 'env-1', { id: 'a', method: 'terminal.list' }, '{"id":"a"}')
    relay.forward(tablet, 'env-1', { id: 'b', method: 'terminal.list' }, '{"id":"b"}')
    await vi.waitFor(() => expect(sockets.map((socket) => socket.sent.length)).toEqual([1, 1]))
    expect(syncCalls).toHaveLength(1)
  })

  it('closes a socket still opening when its server is removed, answering and never sending its requests', async () => {
    sockets.length = 0
    let release = () => {}
    openGate.wait = new Promise((resolve) => (release = resolve))
    const { relay, phone, replies } = relayWithPhone()
    relay.forward(phone, 'env-1', { id: 'a', method: 'terminal.list' }, '{"id":"a"}')
    await vi.waitFor(() => expect(sockets).toHaveLength(1))
    relay.retireEnvironment('env-1')
    expect(JSON.parse(replies[0]!)).toMatchObject({
      id: 'a',
      error: { code: 'remote_runtime_unavailable' }
    })
    release()
    await vi.waitFor(() => expect(sockets[0]!.closed).toBe(true))
    expect(sockets[0]!.sent).toEqual([])
    openGate.wait = Promise.resolve()
  })

  it('opens nothing for a phone that disconnects while its server syncs, and answers nobody', async () => {
    sockets.length = 0
    let finishSync = () => {}
    const { relay, phone, replies, syncCalls } = relayWithPhone(
      () => new Promise((resolve) => (finishSync = () => resolve(SYNCED)))
    )
    relay.forward(phone, 'env-1', { id: 'a', method: 'terminal.list' }, '{"id":"a"}')
    await vi.waitFor(() => expect(syncCalls).toHaveLength(1))
    relay.closePhoneConnection('conn-1')
    finishSync()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(sockets).toEqual([])
    expect(replies).toEqual([])
  })

  it('relays to a server upgraded in place without waiting for a re-pair', async () => {
    sockets.length = 0
    const { relay, phone, replies, server } = relayWithPhone()
    server.capable = false
    relay.forward(phone, 'env-1', { id: 'a', method: 'terminal.list' }, '{"id":"a"}')
    await vi.waitFor(() => expect(replies).toHaveLength(1))
    expect(JSON.parse(replies[0]!).error.message).toContain('update')
    server.capable = true
    relay.forward(phone, 'env-1', { id: 'b', method: 'terminal.list' }, '{"id":"b"}')
    await vi.waitFor(() => expect(sockets[0]?.sent).toHaveLength(1))
  })

  it('does not sync again for a phone the server just declined to grant', async () => {
    sockets.length = 0
    const { relay, phone, replies, syncCalls } = relayWithPhone(() =>
      ok({ devices: [{ phoneKey: 'phone-2', deviceId: 'child-2', token: 'host-token-2' }] })
    )
    relay.forward(phone, 'env-1', { id: 'a', method: 'terminal.list' }, '{"id":"a"}')
    await vi.waitFor(() => expect(replies).toHaveLength(1))
    relay.forward(phone, 'env-1', { id: 'b', method: 'terminal.list' }, '{"id":"b"}')
    await vi.waitFor(() => expect(replies).toHaveLength(2))
    expect(replies.map((frame) => JSON.parse(frame).error.code)).toEqual([
      'remote_runtime_unavailable',
      'remote_runtime_unavailable'
    ])
    expect(syncCalls).toHaveLength(1)
    expect(sockets).toEqual([])
  })

  it('ends the link when a mirrored capability update cannot be queued', async () => {
    sockets.length = 0
    const { relay, phone, replies } = relayWithPhone()
    relay.forward(phone, 'env-1', { id: 'a', method: 'terminal.list' }, '{"id":"a"}')
    await vi.waitFor(() => expect(sockets[0]?.sent).toHaveLength(1))
    sockets[0]!.accepts = false
    relay.forwardClientCapabilities(
      'conn-1',
      '{"id":"caps","method":"runtime.clientCapabilities.update"}'
    )
    await vi.waitFor(() => expect(sockets[0]!.closed).toBe(true))
    expect(JSON.parse(replies[0]!)).toMatchObject({
      id: 'a',
      error: { code: 'remote_runtime_unavailable' }
    })
  })
})
