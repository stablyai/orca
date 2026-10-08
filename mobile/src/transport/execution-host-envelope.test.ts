import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY } from '../../../src/shared/mobile-desktop-relay-contract'
import {
  scopeRpcClientToExecutionHost,
  workspaceRouteExecutionHost
} from './execution-host-scoped-rpc-client'
import { MobileRelayRpcStreams } from './mobile-relay-rpc-streams'
import type { RpcClient } from './rpc-client'
import { RpcClientRequestTracker } from './rpc-client-request-tracker'
import { RpcClientStreamRegistry } from './rpc-client-stream-registry'
import type { RpcResponse } from './types'

const SERVER = 'runtime:env-1' as const

const FrameSchema = z.looseObject({
  id: z.string(),
  method: z.string(),
  params: z.unknown().optional(),
  executionHost: z.string().optional()
})
type Frame = z.infer<typeof FrameSchema>

function ready(id: string, subscriptionId: string): RpcResponse {
  return {
    id,
    ok: true,
    streaming: true,
    result: { type: 'ready', subscriptionId },
    _meta: { runtimeId: 'runtime-1' }
  }
}

function directRegistry() {
  const sent: Frame[] = []
  let id = 0
  const registry = new RpcClientStreamRegistry({
    nextId: () => `rpc-${++id}`,
    deviceToken: 'device-token',
    getState: () => 'connected',
    sendEncrypted: (request) => {
      sent.push(FrameSchema.parse(request))
      return true
    }
  })
  return { registry, sent }
}

describe('executionHost on the envelope', () => {
  it('puts a request target on the envelope and leaves untargeted requests unchanged', async () => {
    const sent: Frame[] = []
    let id = 0
    const tracker = new RpcClientRequestTracker({
      nextId: () => `rpc-${++id}`,
      getState: () => 'connected',
      waitForConnected: async () => {},
      sendEncrypted: (request) => {
        sent.push(FrameSchema.parse(request))
        return true
      },
      deviceToken: 'device-token'
    })
    void tracker.sendRequest('worktree.ps', {}, { executionHost: SERVER })
    void tracker.sendRequest('worktree.ps', {})
    await vi.waitFor(() => expect(sent).toHaveLength(2))
    expect(sent[0]).toEqual({
      id: 'rpc-1',
      deviceToken: 'device-token',
      method: 'worktree.ps',
      params: {},
      executionHost: SERVER
    })
    expect(sent[1]).not.toHaveProperty('executionHost')
  })

  it('keeps a stream target on its replay and its unsubscribe', () => {
    const { registry, sent } = directRegistry()
    const dispose = registry.subscribe('terminal.subscribe', { terminal: 't1' }, () => {}, {
      executionHost: SERVER
    })
    registry.markForReplay()
    registry.replayAfterAuthentication()
    dispose()
    expect(sent.map((frame) => [frame.method, frame.executionHost])).toEqual([
      ['terminal.subscribe', SERVER],
      ['terminal.subscribe', SERVER],
      ['terminal.unsubscribe', SERVER]
    ])
  })

  it('names the target on a ready-id stream unsubscribe', () => {
    const { registry, sent } = directRegistry()
    const dispose = registry.subscribe('browser.screencast', { page: 'p' }, () => {}, {
      executionHost: SERVER
    })
    registry.handleResponse(ready(sent[0]!.id, 'sub-1'))
    dispose()
    expect(sent.at(-1)).toMatchObject({
      method: 'browser.screencast.unsubscribe',
      params: { subscriptionId: 'sub-1' },
      executionHost: SERVER
    })
  })

  it('names the target on every cloud-relay stream frame', async () => {
    const sent: Frame[] = []
    let id = 0
    const streams = new MobileRelayRpcStreams({
      nextId: () => `relay-${++id}`,
      sendFrame: (frame) => {
        sent.push(frame)
        return true
      },
      waitForConnected: async () => {}
    })
    const dispose = streams.subscribe(
      'terminal.subscribe',
      { terminal: 't1', client: { id: 'phone', type: 'mobile' } },
      () => {},
      { executionHost: SERVER }
    )
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    dispose()
    expect(sent.map((frame) => [frame.method, frame.executionHost])).toEqual([
      ['terminal.subscribe', SERVER],
      ['terminal.unsubscribe', SERVER]
    ])
  })

  it('does not let a local terminal stream evict a same-handle stream on a server', async () => {
    const sent: Frame[] = []
    let id = 0
    const streams = new MobileRelayRpcStreams({
      nextId: () => `relay-${++id}`,
      sendFrame: (frame) => {
        sent.push(frame)
        return true
      },
      waitForConnected: async () => {}
    })
    const params = { terminal: 't1', client: { id: 'phone', type: 'mobile' } }
    const disposeServer = streams.subscribe('terminal.subscribe', params, () => {}, {
      executionHost: SERVER
    })
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    streams.subscribe('terminal.subscribe', params, () => {})
    await vi.waitFor(() => expect(sent).toHaveLength(2))
    disposeServer()
    expect(sent.at(-1)).toMatchObject({ method: 'terminal.unsubscribe', executionHost: SERVER })
  })
})

function fakeClient(carries?: boolean) {
  const sendRequest = vi.fn(async (): Promise<RpcResponse> => ({
    id: 'reply',
    ok: true,
    result: null
  }))
  const subscribe = vi.fn(() => () => {})
  const close = vi.fn()
  const client = {
    sendRequest,
    subscribe,
    close,
    updateTerminalSubscriptionViewport: vi.fn(),
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange: () => () => {},
    notifyForeground: vi.fn(),
    ...(carries === undefined ? {} : { carriesExecutionHost: () => carries })
  } satisfies RpcClient
  return client
}

describe('scopeRpcClientToExecutionHost', () => {
  it('runs every request and stream on the host, as one stable view that owns no connection', () => {
    const client = fakeClient()
    const view = scopeRpcClientToExecutionHost(client, SERVER)
    void view.sendRequest('worktree.ps', { limit: 1 }, { timeoutMs: 5 })
    view.subscribe('terminal.subscribe', { terminal: 't1' }, () => {})
    view.close()
    expect(client.sendRequest).toHaveBeenCalledWith(
      'worktree.ps',
      { limit: 1 },
      { timeoutMs: 5, executionHost: SERVER }
    )
    expect(client.subscribe).toHaveBeenCalledWith(
      'terminal.subscribe',
      { terminal: 't1' },
      expect.any(Function),
      { executionHost: SERVER }
    )
    expect(client.close).not.toHaveBeenCalled()
    expect(scopeRpcClientToExecutionHost(client, SERVER)).toBe(view)
    expect(scopeRpcClientToExecutionHost(client, 'runtime:env-2')).not.toBe(view)
  })

  it('routes a server workspace only through a relaying desktop over a transport that keeps the field', () => {
    const relays = [MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY]
    expect(workspaceRouteExecutionHost(fakeClient(), relays, SERVER)).toBe(SERVER)
    expect(workspaceRouteExecutionHost(fakeClient(true), relays, SERVER)).toBe(SERVER)
    expect(workspaceRouteExecutionHost(fakeClient(false), relays, SERVER)).toBeNull()
    expect(workspaceRouteExecutionHost(fakeClient(), [], SERVER)).toBeNull()
    expect(workspaceRouteExecutionHost(null, relays, SERVER)).toBeNull()
    expect(workspaceRouteExecutionHost(fakeClient(), relays, 'local')).toBeUndefined()
    expect(workspaceRouteExecutionHost(fakeClient(), relays, 'ssh:box')).toBeUndefined()
    expect(workspaceRouteExecutionHost(fakeClient(), relays, undefined)).toBeUndefined()
  })
})
