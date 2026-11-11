import type { PairedRuntimeConnection } from '../../../shared/remote-runtime/pairing/paired-runtime-connection'
import { describe, expect, it, vi } from 'vitest'
import { DELEGATED_MOBILE_DEVICES_RUNTIME_CAPABILITY } from '../../../shared/delegated-mobile-device-contract'

import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import { RemoteRuntimeClientError } from '../../../shared/remote-runtime/remote-runtime-client-error'
import type { RemoteRuntimePassthroughCallbacks } from '../../../shared/remote-runtime/remote-runtime-passthrough-socket'
import { MobileDesktopRelay } from './mobile-desktop-relay'
import type { RelayedPhone } from './mobile-desktop-relay-link'
import type { MobileDesktopRelayHost, MobileDesktopRelayHosts } from './mobile-desktop-relay-hosts'

type FakeSocket = {
  pairing: PairedRuntimeConnection
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
// Hold sockets open so tests can act during connection.
const openGate = vi.hoisted(() => ({ wait: Promise.resolve() }))
vi.mock('../../../shared/remote-runtime/remote-runtime-passthrough-socket', () => ({
  openRemoteRuntimePassthroughSocket: async (
    pairing: PairedRuntimeConnection,
    capabilities: readonly string[],
    callbacks: RemoteRuntimePassthroughCallbacks
  ) => {
    const socket: FakeSocket = {
      pairing,
      sent: [],
      capabilities,
      callbacks,
      closed: false,
      accepts: true
    }
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
    SYNCED,
  prepareBrowserHost?: (host: MobileDesktopRelayHost) => Promise<string | null>
) {
  const syncCalls: unknown[] = []
  const server = { capable: true }
  const desktop: { nativeChatDefault: boolean } = { nativeChatDefault: true }
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
      pairingRevision: 7,
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
    hostsBrowserPage: () => false,
    onEnvironmentRetired: () => () => {},
    onStatusChanged: () => () => {},
    watchChanges: () => ({ close: () => {}, current: () => true })
  }
  const relay = new MobileDesktopRelay({
    hosts,
    listPhones: () => [
      { phoneKey: 'phone-1', name: 'iPhone via Mac' },
      { phoneKey: 'phone-2', name: 'iPad via Mac' }
    ],
    allocateStreamId: () => 1,
    nativeChatDefault: () => desktop.nativeChatDefault,
    prepareBrowserHost
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
    hosts,
    relay,
    phone,
    replies,
    syncCalls,
    server,
    desktop,
    setCapabilities: (next: string[]) => (capabilities = next)
  }
}

describe('MobileDesktopRelay', () => {
  it('preserves the desktop edge credentials while using the delegated phone identity', async () => {
    sockets.length = 0
    const { relay, phone, hosts, replies } = relayWithPhone()
    const edgeAuth = {
      origin: 'wss://orca.example',
      hostPublicKeyB64: 'k',
      headers: { 'X-Token': 'synthetic-secret' }
    }
    hosts.resolve = async (environmentId) => ({
      environmentId,
      fence: 'f',
      pairing: { v: 2, endpoint: 'wss://orca.example', deviceToken: 'desktop', publicKeyB64: 'k' },
      edgeAuth
    })
    relay.forward(
      phone,
      'env-1',
      { id: 'r1', method: 'terminal.list' },
      '{"id":"r1","method":"terminal.list"}'
    )
    await vi.waitFor(() => expect(sockets[0]?.sent.length).toBe(1))
    expect(sockets[0]?.pairing).toMatchObject({
      edgeAuth,
      credential: { kind: 'token', deviceToken: 'host-token' },
      pairedDeviceId: 'child'
    })
    expect(JSON.stringify(replies)).not.toContain('synthetic-secret')
    expect(sockets[0]?.sent.join('')).not.toContain('synthetic-secret')
    relay.dispose()
  })

  it.each([
    ['its own wake', true],
    ['an unrelated replacement', false]
  ] as const)(
    'retires a link still preparing when its server is re-paired, except by %s',
    async (_cause, wokenByOpening) => {
      sockets.length = 0
      const { relay, hosts, phone, replies } = relayWithPhone()
      const listing = { id: 'list', method: 'worktree.ps' }
      relay.forward(phone, 'env-1', listing, JSON.stringify(listing))
      await vi.waitFor(() => expect(sockets[0]?.sent).toHaveLength(1))
      // A paired link is retired at once.
      relay.retireEnvironment('env-1')
      await vi.waitFor(() => expect(replies).toHaveLength(1))

      const opening = Promise.withResolvers<Awaited<ReturnType<typeof hosts.resolve>>>()
      vi.spyOn(hosts, 'resolve').mockImplementationOnce(() => opening.promise)
      const open = { id: 'open', method: 'worktree.activate' }
      relay.forward(phone, 'env-1', open, JSON.stringify(open))
      relay.retireEnvironment('env-1')
      opening.resolve({
        environmentId: 'env-1',
        fence: 'f',
        pairingRevision: 8,
        ...(wokenByOpening ? { wokenByOpening: true as const } : {}),
        pairing: { v: 2, endpoint: 'ws://127.0.0.1:1', deviceToken: 'desktop', publicKeyB64: 'k' }
      })
      if (wokenByOpening) {
        await vi.waitFor(() =>
          expect(sockets.at(-1)?.sent.some((frame) => frame.includes('"open"'))).toBe(true)
        )
        expect(replies).toHaveLength(1)
      } else {
        await vi.waitFor(() => expect(replies).toHaveLength(2))
        expect(JSON.parse(replies[1]!)).toMatchObject({
          id: 'open',
          error: { code: 'remote_runtime_unavailable' }
        })
      }
      relay.dispose()
    }
  )

  it('refuses transient preparation failures so the phone can retry its capability probe', async () => {
    sockets.length = 0
    const prepare = vi
      .fn()
      .mockRejectedValueOnce(new Error('browser_client_host_runtime_not_ready'))
      .mockResolvedValue('desktop-host')
    const { relay, hosts, phone, replies } = relayWithPhone(undefined, prepare)
    hosts.browserHostClientId = () => (prepare.mock.calls.length > 1 ? 'desktop-host' : null)
    relay.forward(
      phone,
      'env-1',
      { id: 'first', method: 'status.get' },
      '{"id":"first","method":"status.get"}'
    )
    await vi.waitFor(() => expect(replies).toHaveLength(1))
    expect(JSON.parse(replies[0]!)).toMatchObject({
      ok: false,
      error: { code: 'remote_runtime_unavailable' }
    })
    expect(sockets[0]!.sent).toEqual([])
    relay.forward(
      phone,
      'env-1',
      { id: 'retry', method: 'status.get' },
      '{"id":"retry","method":"status.get"}'
    )
    await vi.waitFor(() => expect(sockets[0]!.sent).toHaveLength(1))
    sockets[0]!.callbacks.onText(JSON.stringify({ ...ok({ capabilities: [] }), id: 'retry' }))
    expect(JSON.parse(replies[1]!)).toMatchObject({
      ok: true,
      result: { capabilities: ['browser.screencast.v1'] }
    })
    relay.dispose()
  })

  it('answers every request still open when the server socket drops, then closes on phone disconnect', async () => {
    sockets.length = 0
    const { relay, phone, replies } = relayWithPhone()
    relay.forward(phone, 'env-1', { id: 'a', method: 'terminal.list' }, '{"id":"a"}')
    relay.forward(phone, 'env-1', { id: 'b', method: 'terminal.list' }, '{"id":"b"}')
    await vi.waitFor(() => expect(sockets[0]?.sent).toHaveLength(2))
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
})
