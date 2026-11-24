import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import type { DocumentDeliveryEndpoint } from '../../../../shared/backend/document-delivery-endpoint'

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

import { routeSharedHostsThrough } from './runtime-environment-shared-hosts'
import { callRuntimeEnvironment } from './runtime-environment-transport-routing'
import { registerRuntimeEnvironmentPassiveHandlers } from '../connectivity/runtime-environment-connectivity-handlers'
import { subscribeRuntimeEnvironmentForDocument } from '../subscriptions/runtime-environment-document-subscription'
import type { RetainedRemoteRuntimeSubscription } from '../subscriptions/runtime-environment-subscription-setup'

const SHARED = 'shared-env'
const PAIRED = 'paired-env'
const answer = (method: string): RuntimeRpcResponse<unknown> => ({
  id: method,
  ok: true,
  result: { method },
  _meta: { runtimeId: SHARED }
})
const stop = vi.fn()
const hosts = {
  ready: vi.fn(async () => {}),
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
  )
}

function windowCall(selector: string, method: string): Promise<RuntimeRpcResponse<unknown>> {
  const handler = ipc.handlers.get('runtimeEnvironments:call')!
  return handler({}, { selector, method, params: {} })
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

beforeEach(() => {
  registry.resolve.mockReset().mockRejectedValue(new Error('paired-server registry'))
  hosts.call.mockClear()
  hosts.subscribe.mockClear()
  stop.mockClear()
  subscriptions.clear()
  routeSharedHostsThrough(hosts)
  registerRuntimeEnvironmentPassiveHandlers(() => '/nowhere')
})

afterEach(() => {
  routeSharedHostsThrough(null)
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
    // Nor a status probe: the host answers none to a share.
    expect(await callRuntimeEnvironment('/nowhere', SHARED, 'status.get', undefined)).toMatchObject(
      { ok: false, error: { code: 'method_not_found' } }
    )
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
