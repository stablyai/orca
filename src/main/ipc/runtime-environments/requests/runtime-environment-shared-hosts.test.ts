import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import type { DocumentDeliveryEndpoint } from '../../../../shared/backend/document-delivery-endpoint'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SHARED_HOSTS_HOLD_WHILE_AWAY,
  type SharedBotHostView
} from '../../../../shared/bots/shared-bot-hosts'
import {
  newSharedBotHostEntry,
  SharedBotHostStore
} from '../../../bots/shared-with-me/shared-bot-host-store'

type Handler = (event: unknown, args: unknown) => Promise<RuntimeRpcResponse<unknown>>
const ipc = vi.hoisted(() => ({ handlers: new Map<string, Handler>() }))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: Handler) => ipc.handlers.set(channel, handler),
    removeHandler: (channel: string) => ipc.handlers.delete(channel)
  }
}))
// Every paired-server path starts by resolving its selector in the registry.
const registry = vi.hoisted(() => ({ resolve: vi.fn() }))
vi.mock('../../../../shared/remote-runtime/host-store/runtime-environment-store', async (load) => ({
  ...(await load<object>()),
  resolveEnvironment: registry.resolve
}))

import {
  routeSharedHostsThrough,
  sharedHostsChanged,
  sharedHostStatusSnapshots
} from './runtime-environment-shared-hosts'
import {
  isBotShareMethod,
  isBotShareStreamMethod
} from '../../../runtime/rpc/methods/rpc-method-share'
import { SharedBotPhoneGrants } from '../../../bots/shared-with-me/shared-bot-phone-grants'
import { callRuntimeEnvironment } from './runtime-environment-transport-routing'
import { registerRuntimeEnvironmentPassiveHandlers } from '../connectivity/runtime-environment-connectivity-handlers'
import { subscribeRuntimeEnvironmentForDocument } from '../subscriptions/runtime-environment-document-subscription'
import type { RetainedRemoteRuntimeSubscription } from '../subscriptions/runtime-environment-subscription-setup'

// Held sends are off while SHARED_HOSTS_HOLD_WHILE_AWAY is: their tests run again when it is on.
const heldIt = it.skipIf(!SHARED_HOSTS_HOLD_WHILE_AWAY)

const SHARED = 'shared-env'
const PAIRED = 'paired-env'
const answer = (method: string): RuntimeRpcResponse<unknown> => ({
  id: method,
  ok: true,
  result: { method, runtimeId: SHARED },
  _meta: { runtimeId: SHARED }
})
const stop = vi.fn()
const view: SharedBotHostView = {
  environmentId: SHARED,
  shareId: 'share-1',
  botId: 'bot-1',
  botName: 'Helper',
  ownerName: 'Owner',
  homeWorkspaceId: null,
  link: 'live',
  holds: true,
  held: []
}
let views: SharedBotHostView[] = []
let storeDir = ''
let store = new SharedBotHostStore('/nowhere')
const sharedEntry = () => ({ ...newSharedBotHostEntry(view), environmentId: SHARED })
const hosts = {
  ready: vi.fn(async () => {}),
  views: () => views,
  get store() {
    return store
  },
  reaches: (environmentId: string) => environmentId === SHARED,
  call: vi.fn(async (_environmentId: string, method: string) => answer(method)),
  subscribe: vi.fn(
    async (
      _environmentId: string,
      method: string,
      _params: unknown,
      onResponse: (response: RuntimeRpcResponse<unknown>) => void
    ) => {
      onResponse(answer(method))
      return stop
    }
  ),
  phones: new SharedBotPhoneGrants({
    store: new SharedBotHostStore('/nowhere'),
    listed: () => [],
    reach: async () => 'live',
    request: async () => ({ id: 'unused', ok: true, result: null }),
    origin: () => null
  })
}

function windowCall(selector: string, method: string): Promise<RuntimeRpcResponse<unknown>> {
  const handler = ipc.handlers.get('runtimeEnvironments:call')!
  return handler({}, { selector, method, params: {} })
}

function windowGetStatus(selector: string): Promise<RuntimeRpcResponse<unknown>> {
  return ipc.handlers.get('runtimeEnvironments:getStatus')!({}, { selector })
}

function windowDocument() {
  const retirement = new AbortController()
  const send = vi.fn()
  const document: DocumentDeliveryEndpoint = {
    hostId: 7,
    isGone: () => false,
    isCurrent: () => true,
    send,
    watchRetirement: () => ({ signal: retirement.signal, dispose: () => {} })
  }
  return { document, send, retire: () => retirement.abort() }
}

const subscriptions = new Map<string, RetainedRemoteRuntimeSubscription>()
function windowSubscribe(document: DocumentDeliveryEndpoint, selector: string, method: string) {
  return subscribeRuntimeEnvironmentForDocument(
    {
      getUserDataPath: () => '/nowhere',
      remoteRuntimeSubscriptions: subscriptions,
      pendingSubscriptions: new Map(),
      recordLayoutFrame: () => {}
    },
    document,
    { selector, method, params: { sessionId: 's' } }
  )
}

beforeEach(async () => {
  storeDir = await mkdtemp(join(tmpdir(), 'orca-shared-host-status-'))
  store = new SharedBotHostStore(storeDir)
  store.put(sharedEntry())
  registry.resolve.mockReset().mockRejectedValue(new Error('paired-server registry'))
  hosts.call.mockClear()
  hosts.subscribe.mockClear()
  stop.mockClear()
  views = [{ ...view }]
  subscriptions.clear()
  routeSharedHostsThrough({
    hosts,
    methods: { allows: isBotShareMethod, streams: isBotShareStreamMethod }
  })
  registerRuntimeEnvironmentPassiveHandlers(() => '/nowhere')
})

afterEach(async () => {
  routeSharedHostsThrough(null)
  await store.flushed()
  await rm(storeDir, { recursive: true, force: true })
})

describe('a shared agent’s host, reached through runtimeEnvironments', () => {
  it('takes the window’s calls and main’s own (uploads) over its share link', async () => {
    expect(await windowCall(SHARED, 'bots.list')).toEqual(answer('bots.list'))
    expect(
      await callRuntimeEnvironment('/nowhere', SHARED, 'agentSessionAttachment.uploadStart', {})
    ).toEqual(answer('agentSessionAttachment.uploadStart'))
    expect(hosts.call).toHaveBeenCalledTimes(2)
    expect(registry.resolve).not.toHaveBeenCalled()
  })

  it('never sends a method the share refuses, and answers it as the host would', async () => {
    for (const method of ['bots.activity', 'bots.upNext.unseen', 'pairedServerAsks.list']) {
      expect(await windowCall(SHARED, method)).toMatchObject({
        ok: false,
        error: { code: 'method_not_found' }
      })
    }
    const { document, send } = windowDocument()
    await windowSubscribe(document, SHARED, 'bots.items.subscribe')
    expect(send).toHaveBeenCalledWith(
      'runtimeEnvironments:subscriptionEvent',
      expect.objectContaining({ response: expect.objectContaining({ ok: false }) })
    )
    expect(hosts.call).not.toHaveBeenCalled()
    expect(hosts.subscribe).not.toHaveBeenCalled()
    expect(registry.resolve).not.toHaveBeenCalled()
  })

  it('streams over its link until the window unsubscribes or goes away', async () => {
    const { document, send, retire } = windowDocument()
    const { subscriptionId } = await windowSubscribe(document, SHARED, 'agentSession.subscribe')
    expect(hosts.subscribe).toHaveBeenCalledWith(
      SHARED,
      'agentSession.subscribe',
      { sessionId: 's' },
      expect.any(Function)
    )
    expect(send).toHaveBeenCalledWith('runtimeEnvironments:subscriptionEvent', {
      subscriptionId,
      type: 'response',
      response: answer('agentSession.subscribe')
    })
    subscriptions.get(subscriptionId)!.close()
    expect(stop).toHaveBeenCalledTimes(1)
    expect(subscriptions.size).toBe(0)

    await windowSubscribe(document, SHARED, 'agentSession.subscribeStatus')
    retire()
    expect(stop).toHaveBeenCalledTimes(2)
    expect(subscriptions.size).toBe(0)
    expect(registry.resolve).not.toHaveBeenCalled()
  })

  it('answers an abortable call (sent as a stream) once, as a call', async () => {
    const { document, send } = windowDocument()
    await windowSubscribe(document, SHARED, 'bots.chats')
    expect(hosts.call).toHaveBeenCalledWith(SHARED, 'bots.chats', { sessionId: 's' })
    expect(hosts.subscribe).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith(
      'runtimeEnvironments:subscriptionEvent',
      expect.objectContaining({ response: answer('bots.chats') })
    )
  })
})

describe('a shared agent’s host status, as a paired server’s', () => {
  it('answers getStatus and lists a verified, ready snapshot the window keeps', async () => {
    expect(await windowGetStatus(SHARED)).toEqual(answer('status.get'))
    // The window's capability reads ask status.get as a call; the same owner answers it.
    expect(await windowCall(SHARED, 'status.get')).toEqual(answer('status.get'))
    expect(sharedHostStatusSnapshots()).toEqual([
      expect.objectContaining({
        environmentId: SHARED,
        sharedHost: true,
        transport: 'ready',
        verification: 'verified',
        status: { method: 'status.get', runtimeId: SHARED }
      })
    ])
    expect(registry.resolve).not.toHaveBeenCalled()
  })

  const offline = { id: 'status.get', ok: false, error: { code: 'offline', message: '' } } as const

  // The owner's computer away since this Orca launched: no live answer this run.
  heldIt(
    'answers verified and ready while its owner is away and messages are held, with no earlier answer',
    async () => {
      views = [{ ...view, link: 'offline' }]
      hosts.call.mockResolvedValue(offline)
      expect(await windowGetStatus(SHARED)).toMatchObject({ ok: true })
      expect(sharedHostStatusSnapshots()[0]).toMatchObject({
        transport: 'ready',
        verification: 'verified'
      })
      hosts.call.mockImplementation(async (_environmentId: string, method: string) =>
        answer(method)
      )
    }
  )

  heldIt(
    'keeps the host’s last answer with its share, so it still reads that way after a restart',
    async () => {
      await windowGetStatus(SHARED)
      await store.flushed()
      store = new SharedBotHostStore(storeDir)
      await store.load()
      routeSharedHostsThrough({
        hosts,
        methods: { allows: isBotShareMethod, streams: isBotShareStreamMethod }
      })
      views = [{ ...view, link: 'offline' }]
      hosts.call.mockResolvedValueOnce(offline)
      expect(await windowGetStatus(SHARED)).toMatchObject({
        ok: true,
        result: { runtimeId: SHARED }
      })
    }
  )

  it('reads disconnected with no held messages, and retires when the share goes', async () => {
    views = [{ ...view, link: 'offline', holds: false }]
    hosts.call.mockResolvedValueOnce({
      id: 'status.get',
      ok: false,
      error: { code: 'offline', message: '' }
    })
    expect(await windowGetStatus(SHARED)).toMatchObject({ ok: false })
    expect(sharedHostStatusSnapshots()[0]).toMatchObject({ transport: 'disconnected' })
    views = []
    sharedHostsChanged()
    expect(sharedHostStatusSnapshots()).toEqual([])
  })
})

describe('a paired server', () => {
  it('is still reached through the paired-server registry, never a share link', async () => {
    await expect(windowCall(PAIRED, 'bots.list')).rejects.toThrow('paired-server registry')
    await expect(callRuntimeEnvironment('/nowhere', PAIRED, 'bots.list', {})).rejects.toThrow(
      'paired-server registry'
    )
    const { document } = windowDocument()
    await expect(windowSubscribe(document, PAIRED, 'agentSession.subscribe')).rejects.toThrow(
      'paired-server registry'
    )
    expect(registry.resolve).toHaveBeenCalledTimes(3)
    expect(hosts.call).not.toHaveBeenCalled()
    expect(hosts.subscribe).not.toHaveBeenCalled()
  })
})
