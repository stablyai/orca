import { describe, expect, it, vi } from 'vitest'
import { DELEGATED_MOBILE_DEVICES_RUNTIME_CAPABILITY } from '../../../shared/delegated-mobile-device-contract'
import { BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import { RemoteRuntimeClientError } from '../../../shared/remote-runtime/remote-runtime-client-error'
import type { RemoteRuntimePassthroughCallbacks } from '../../../shared/remote-runtime/remote-runtime-passthrough-socket'
import { MobileDesktopRelay, type RelayedPhone } from './mobile-desktop-relay'
import type { MobileDesktopRelayHost, MobileDesktopRelayHosts } from './mobile-desktop-relay-hosts'

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
// Hold sockets open so tests can act during connection.
const openGate = vi.hoisted(() => ({ wait: Promise.resolve() }))
vi.mock('../../../shared/remote-runtime/remote-runtime-passthrough-socket', () => ({
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
  // #36923: a phone opening a workspace whose recipe VM sleeps wakes it; nothing else does.
  it('opens a server link for the request that needs it and relays the VM waking answer', async () => {
    sockets.length = 0
    const { relay, hosts, phone, replies } = relayWithPhone()
    const resolve = vi.spyOn(hosts, 'resolve').mockImplementation(async (_id, openingMethod) => {
      throw new RemoteRuntimeClientError(
        openingMethod === 'worktree.activate'
          ? 'runtime_environment_waking'
          : 'runtime_environment_asleep',
        'VM'
      )
    })
    const listing = { id: 'list', method: 'worktree.ps' }
    relay.forward(phone, 'env-1', listing, JSON.stringify(listing))
    await vi.waitFor(() => expect(replies).toHaveLength(1))
    const open = { id: 'open', method: 'worktree.activate' }
    relay.forward(phone, 'env-1', open, JSON.stringify(open))
    await vi.waitFor(() => expect(replies).toHaveLength(2))

    expect(resolve.mock.calls.map(([, openingMethod]) => openingMethod)).toEqual([
      'worktree.ps',
      'worktree.activate'
    ])
    expect(replies.map((reply) => JSON.parse(reply).error.code)).toEqual([
      'runtime_environment_asleep',
      'runtime_environment_waking'
    ])
    expect(sockets).toHaveLength(0)
    relay.dispose()
  })

  it('wakes the VM for a workspace open that joins a link a background request is opening', async () => {
    sockets.length = 0
    const { relay, hosts, phone, replies } = relayWithPhone()
    const resolve = vi.spyOn(hosts, 'resolve').mockImplementation(async (_id, openingMethod) => {
      throw new RemoteRuntimeClientError(
        openingMethod === 'worktree.activate'
          ? 'runtime_environment_waking'
          : 'runtime_environment_asleep',
        'VM'
      )
    })
    // The server is going or gone, so the opening link cannot carry the open.
    hosts.serverStateForOpening = () => 'waking'
    const listing = { id: 'list', method: 'worktree.ps' }
    const open = { id: 'open', method: 'worktree.activate' }
    relay.forward(phone, 'env-1', listing, JSON.stringify(listing))
    relay.forward(phone, 'env-1', open, JSON.stringify(open))
    await vi.waitFor(() => expect(replies).toHaveLength(2))

    expect(resolve.mock.calls.map(([, openingMethod]) => openingMethod)).toEqual([
      'worktree.ps',
      'worktree.activate'
    ])
    expect(replies.map((reply) => JSON.parse(reply).error.code)).toEqual([
      'runtime_environment_waking',
      'runtime_environment_waking'
    ])
    relay.dispose()
  })

  it.each([
    ['up', null, 1],
    ['waking', 'runtime_environment_waking', 2],
    ['asleep', 'runtime_environment_asleep', 2]
  ] as const)(
    'carries a workspace open on an open link only while its VM is up (VM %s)',
    async (state, refusal, links) => {
      sockets.length = 0
      const { relay, hosts, phone, replies } = relayWithPhone()
      const serverStateForOpening = vi.fn(() => state)
      hosts.serverStateForOpening = serverStateForOpening
      const resolve = vi.spyOn(hosts, 'resolve')
      const listing = { id: 'list', method: 'worktree.ps' }
      relay.forward(phone, 'env-1', listing, JSON.stringify(listing))
      await vi.waitFor(() => expect(sockets[0]?.sent).toHaveLength(1))
      expect(serverStateForOpening).not.toHaveBeenCalled()

      const open = { id: 'open', method: 'worktree.activate' }
      relay.forward(phone, 'env-1', open, JSON.stringify(open))
      expect(serverStateForOpening).toHaveBeenCalledExactlyOnceWith('env-1')
      // A server whose VM is not up gets a fresh link, whose preparation holds the open; what the
      // old link still carried is answered with where the VM stands.
      expect(resolve).toHaveBeenCalledTimes(links)
      expect(resolve.mock.calls.at(-1)?.[1]).toBe(refusal ? 'worktree.activate' : 'worktree.ps')
      if (refusal) {
        await vi.waitFor(() =>
          expect(replies.map((reply) => JSON.parse(reply).error?.code)).toContain(refusal)
        )
      }
      relay.dispose()
    }
  )

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

  it('refuses a link the user disconnected while it was still preparing', async () => {
    sockets.length = 0
    const { relay, hosts, phone, replies } = relayWithPhone()
    // Disconnected once while preparing, and reconnected since by the wake's own connect.
    let disconnects = 0
    hosts.userDisconnects = () => disconnects
    const resolve = hosts.resolve
    vi.spyOn(hosts, 'resolve').mockImplementationOnce(async (...args) => {
      disconnects += 1
      return resolve(...args)
    })
    const open = { id: 'open', method: 'worktree.activate' }
    relay.forward(phone, 'env-1', open, JSON.stringify(open))
    await vi.waitFor(() => expect(replies).toHaveLength(1))
    expect(JSON.parse(replies[0]!)).toMatchObject({ error: { code: 'remote_runtime_unavailable' } })
    expect(sockets).toHaveLength(0)
    relay.dispose()
  })

  it('keeps a link preparing for a background request when the server behind it is up', async () => {
    sockets.length = 0
    const { relay, hosts, phone, replies } = relayWithPhone()
    hosts.serverStateForOpening = () => 'up'
    const resolve = vi.spyOn(hosts, 'resolve')
    const status = { id: 'status', method: 'worktree.ps' }
    const open = { id: 'open', method: 'worktree.activate' }
    relay.forward(phone, 'env-1', status, JSON.stringify(status))
    relay.forward(phone, 'env-1', open, JSON.stringify(open))
    await vi.waitFor(() => expect(sockets[0]?.sent).toHaveLength(2))
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(replies).toEqual([])
    relay.dispose()
  })

  it('lets a second workspace open join a link already waiting on the VM wake', async () => {
    sockets.length = 0
    const { relay, hosts, phone } = relayWithPhone()
    const waking = Promise.withResolvers<Awaited<ReturnType<typeof hosts.resolve>>>()
    const resolve = vi.spyOn(hosts, 'resolve').mockImplementationOnce(() => waking.promise)
    hosts.serverStateForOpening = () => 'waking'
    const first = { id: 'first', method: 'worktree.activate' }
    const second = { id: 'second', method: 'worktree.activate' }
    relay.forward(phone, 'env-1', first, JSON.stringify(first))
    relay.forward(phone, 'env-1', second, JSON.stringify(second))
    expect(resolve).toHaveBeenCalledTimes(1)
    waking.resolve({
      environmentId: 'env-1',
      fence: 'f',
      pairingRevision: 8,
      pairing: { v: 2, endpoint: 'ws://127.0.0.1:1', deviceToken: 'desktop', publicKeyB64: 'k' }
    })
    await vi.waitFor(() => expect(sockets[0]?.sent).toHaveLength(2))
    relay.dispose()
  })

  // Only a preparation for an open can be waiting on a wake that re-pairs its server.
  it('retires a link preparing for a background request at once', async () => {
    sockets.length = 0
    const { relay, hosts, phone, replies } = relayWithPhone()
    vi.spyOn(hosts, 'resolve').mockImplementationOnce(() => new Promise(() => {}))
    const listing = { id: 'list', method: 'worktree.ps' }
    relay.forward(phone, 'env-1', listing, JSON.stringify(listing))
    relay.retireEnvironment('env-1')
    expect(JSON.parse(replies[0]!)).toMatchObject({
      id: 'list',
      error: { code: 'remote_runtime_unavailable' }
    })
    relay.dispose()
  })

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

  it.each([true, false])(
    'creates on the desktop browser lease only after delegated admission=%s',
    async (admitted) => {
      sockets.length = 0
      const { relay, hosts, phone, replies } = relayWithPhone()
      hosts.browserHostClientId = () => 'desktop-browser-host'
      const call = hosts.call
      const owner = vi
        .spyOn(hosts, 'call')
        .mockImplementation((host, method, params, options) =>
          method === 'browser.tabCreate'
            ? Promise.resolve(ok({ browserPageId: 'phone-page' }))
            : call(host, method, params, options)
        )
      const params = { worktree: 'id:remote-workspace', activate: true }
      const request = { id: 'create', method: 'browser.tabCreate', params }
      relay.forward(phone, 'env-1', request, JSON.stringify(request))
      await vi.waitFor(() => expect(sockets[0]?.sent).toHaveLength(1))
      const admission = JSON.parse(sockets[0]!.sent[0]!)
      expect(admission).toMatchObject({
        method: 'session.tabs.list',
        params: { worktree: params.worktree }
      })
      const response = admitted
        ? ok({ tabs: [] })
        : {
            id: 'x',
            ok: false,
            error: { code: 'not_found', message: 'Workspace not found' },
            _meta: { runtimeId: 'h' }
          }
      sockets[0]!.callbacks.onText(JSON.stringify({ ...response, id: admission.id }))
      await vi.waitFor(() => expect(replies).toHaveLength(1))
      expect(JSON.parse(replies[0]!)).toMatchObject(
        admitted
          ? { id: 'create', ok: true, result: { browserPageId: 'phone-page' } }
          : { id: 'create', ok: false, error: { code: 'not_found' } }
      )
      const creations = owner.mock.calls.filter(([, method]) => method === 'browser.tabCreate')
      expect(creations).toEqual(
        admitted
          ? [
              [
                expect.objectContaining({ environmentId: 'env-1', pairingRevision: 7 }),
                'browser.tabCreate',
                {
                  ...params,
                  activate: false,
                  placement: { kind: 'client', browserHostClientId: 'desktop-browser-host' }
                },
                {
                  expected: { pairingRevision: 7, runtimeId: 'h' },
                  signal: expect.any(AbortSignal)
                }
              ]
            ]
          : []
      )
      relay.dispose()
      if (admitted) {
        expect(creations[0]?.[3]?.signal?.aborted).toBe(true)
      }
    }
  )

  it("stamps the desktop's chat default onto relayed launches only", async () => {
    sockets.length = 0
    const { relay, phone, desktop } = relayWithPhone()
    const frame = (id: string, method: string, params: Record<string, unknown>) =>
      JSON.stringify({ id, deviceToken: 'desktop-token', method, params })
    const target = { kind: 'existing', worktree: 'id:wt-1' }
    // Phone-supplied settings must never override the desktop default.
    relay.forward(
      phone,
      'env-1',
      { id: 'l1', method: 'agent.launch' },
      frame('l1', 'agent.launch', { agent: 'claude', target, nativeChatDefault: false })
    )
    await vi.waitFor(() => expect(sockets[0]?.sent.length).toBe(1))
    desktop.nativeChatDefault = false
    relay.forward(
      phone,
      'env-1',
      { id: 'l2', method: 'agent.launchReplay' },
      frame('l2', 'agent.launchReplay', { agent: 'claude', target, operationId: 'op' })
    )
    relay.forward(
      phone,
      'env-1',
      { id: 'l3', method: 'terminal.list' },
      frame('l3', 'terminal.list', { worktree: 'id:wt-1' })
    )
    await vi.waitFor(() => expect(sockets[0]?.sent.length).toBe(3))
    const sent = sockets[0]!.sent
      .map((text) => JSON.parse(text))
      .sort((a, b) => a.id.localeCompare(b.id))
    expect(sent[0].params).toEqual({ agent: 'claude', target, nativeChatDefault: true })
    expect(sent[1].params).toEqual({
      agent: 'claude',
      target,
      operationId: 'op',
      nativeChatDefault: false
    })
    expect(sent[2].params).toEqual({ worktree: 'id:wt-1' })
    relay.dispose()
  })

  it('signs in with the phone capabilities plus browser tab listing, and mirrors its updates without a second answer', async () => {
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
    expect(sockets[0]!.capabilities).toEqual(['cap.a', BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY])

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
        params: { clientCapabilities: ['cap.b', BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY] }
      })
      expect(mirrored.id).not.toBe('caps')
      expect(mirrored.deviceToken).toBeUndefined()
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
