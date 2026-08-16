import { describe, expect, it, vi } from 'vitest'
import { BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { getBrowserHostLeaseRegistry } from '../../browser-host-lease-registry'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../dispatcher'
import { BROWSER_CLIENT_HOST_METHODS } from './browser-client-host'
import { ALL_RPC_METHODS } from './index'

function request(browserHostClientId = 'host-a', pageCommandProtocolVersion?: 1) {
  return {
    id: `browser-host:${browserHostClientId}`,
    authToken: 'bound-by-websocket',
    method: 'browser.clientHost.attach',
    params: {
      authorityRuntimeId: 'runtime-a',
      browserHostClientId,
      hostCapabilities: ['webview'],
      ...(pageCommandProtocolVersion ? { pageCommandProtocolVersion } : {})
    }
  }
}

function runtime(cleanups = new Map<string, () => void>()): OrcaRuntimeService {
  return {
    getRuntimeId: () => 'runtime-a',
    getStartedAt: () => 1,
    registerSubscriptionCleanup: (id: string, cleanup: () => void) => cleanups.set(id, cleanup)
  } as unknown as OrcaRuntimeService
}

describe('browser.clientHost.attach RPC', () => {
  it('remains outside the production registry while Electron hosting is inactive', () => {
    expect(ALL_RPC_METHODS.some((method) => method.name === 'browser.clientHost.attach')).toBe(
      false
    )
  })

  it('requires an authenticated negotiated paired-runtime connection', async () => {
    const hostRuntime = runtime()
    const dispatcher = new RpcDispatcher({
      runtime: hostRuntime,
      methods: BROWSER_CLIENT_HOST_METHODS
    })
    const replies: string[] = []

    await dispatcher.dispatchStreaming(request(), (reply) => replies.push(reply), {
      connectionId: 'connection-a',
      clientKind: 'runtime',
      pairedDeviceId: 'device-a'
    })

    expect(replies.map((reply) => JSON.parse(reply))).toEqual([
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ message: 'browser_client_host_capability_required' })
      })
    ])
    expect(() => getBrowserHostLeaseRegistry(hostRuntime).select('host-a')).toThrow(
      'browser_host_unavailable'
    )
  })

  it('publishes server-owned epoch and generation then releases on cleanup', async () => {
    const cleanups = new Map<string, () => void>()
    const hostRuntime = runtime(cleanups)
    const dispatcher = new RpcDispatcher({
      runtime: hostRuntime,
      methods: BROWSER_CLIENT_HOST_METHODS
    })
    const replies: string[] = []
    const dispatch = dispatcher.dispatchStreaming(request(), (reply) => replies.push(reply), {
      connectionId: 'connection-a',
      clientKind: 'runtime',
      pairedDeviceId: 'device-a',
      clientCapabilities: [BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY]
    })

    await vi.waitFor(() => expect(replies).toHaveLength(1))
    const ready = JSON.parse(replies[0]!).result
    expect(ready).toMatchObject({ type: 'ready', browserHostGeneration: 1 })
    expect(ready).not.toHaveProperty('pageCommandProtocolVersion')
    expect(ready.authorityEpoch).toEqual(expect.any(String))
    expect(getBrowserHostLeaseRegistry(hostRuntime).select('host-a')).toMatchObject({
      connectionId: 'connection-a',
      pairedDeviceId: 'device-a',
      authorityEpoch: ready.authorityEpoch,
      browserHostGeneration: 1
    })

    cleanups.get('browser-client-host:host-a')?.()
    await dispatch
    expect(JSON.parse(replies[1]!).result).toMatchObject({
      type: 'revoked',
      authorityEpoch: ready.authorityEpoch,
      browserHostGeneration: 1,
      reason: 'released'
    })
    expect(() => getBrowserHostLeaseRegistry(hostRuntime).select('host-a')).toThrow(
      'browser_host_unavailable'
    )
  })

  it('echoes page-command negotiation only to an explicit v1 client', async () => {
    const cleanups = new Map<string, () => void>()
    const hostRuntime = runtime(cleanups)
    const dispatcher = new RpcDispatcher({
      runtime: hostRuntime,
      methods: BROWSER_CLIENT_HOST_METHODS
    })
    const replies: string[] = []
    const dispatch = dispatcher.dispatchStreaming(
      request('host-a', 1),
      (reply) => replies.push(reply),
      {
        connectionId: 'connection-a',
        clientKind: 'runtime',
        pairedDeviceId: 'device-a',
        clientCapabilities: [BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY]
      }
    )

    await vi.waitFor(() => expect(replies).toHaveLength(1))
    expect(JSON.parse(replies[0]!).result).toMatchObject({
      type: 'ready',
      pageCommandProtocolVersion: 1
    })
    cleanups.get('browser-client-host:host-a')?.()
    await dispatch
    expect(JSON.parse(replies[1]!).result).not.toHaveProperty('pageCommandProtocolVersion')
  })

  it('fences a replaced subscription and increments its host generation', async () => {
    const hostRuntime = runtime()
    const dispatcher = new RpcDispatcher({
      runtime: hostRuntime,
      methods: BROWSER_CLIENT_HOST_METHODS
    })
    const firstReplies: string[] = []
    const secondReplies: string[] = []
    const options = {
      clientKind: 'runtime' as const,
      pairedDeviceId: 'device-a',
      clientCapabilities: [BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY]
    }
    const first = dispatcher.dispatchStreaming(request(), (reply) => firstReplies.push(reply), {
      ...options,
      connectionId: 'connection-a'
    })
    await vi.waitFor(() => expect(firstReplies).toHaveLength(1))
    const second = dispatcher.dispatchStreaming(request(), (reply) => secondReplies.push(reply), {
      ...options,
      connectionId: 'connection-b'
    })

    await first
    await vi.waitFor(() => expect(secondReplies).toHaveLength(1))
    expect(JSON.parse(firstReplies[1]!).result).toMatchObject({
      type: 'revoked',
      browserHostGeneration: 1,
      reason: 'replaced'
    })
    expect(JSON.parse(secondReplies[0]!).result).toMatchObject({ browserHostGeneration: 2 })
    getBrowserHostLeaseRegistry(hostRuntime).select('host-a')
    getBrowserHostLeaseRegistry(hostRuntime)
      .attach({
        browserHostClientId: 'host-a',
        connectionId: 'connection-c',
        pairedDeviceId: 'device-a',
        hostCapabilities: ['webview']
      })
      .release()
    await second
  })

  it('rejects a second browser-host identity on one authenticated connection', async () => {
    const cleanups = new Map<string, () => void>()
    const hostRuntime = runtime(cleanups)
    const dispatcher = new RpcDispatcher({
      runtime: hostRuntime,
      methods: BROWSER_CLIENT_HOST_METHODS
    })
    const firstReplies: string[] = []
    const rejectedReplies: string[] = []
    const options = {
      connectionId: 'connection-a',
      clientKind: 'runtime' as const,
      pairedDeviceId: 'device-a',
      clientCapabilities: [BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY]
    }
    const first = dispatcher.dispatchStreaming(
      request('host-a'),
      (reply) => firstReplies.push(reply),
      options
    )
    await vi.waitFor(() => expect(firstReplies).toHaveLength(1))

    await dispatcher.dispatchStreaming(
      request('host-b'),
      (reply) => rejectedReplies.push(reply),
      options
    )

    expect(JSON.parse(rejectedReplies[0]!)).toMatchObject({
      ok: false,
      error: { message: 'browser_host_connection_capacity' }
    })
    cleanups.get('browser-client-host:host-a')?.()
    await first
  })
})
