import { describe, expect, it, vi } from 'vitest'
import { BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { getBrowserHostLeaseRegistry } from '../../browser-host-lease-registry-instance'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../dispatcher'
import { BROWSER_CLIENT_HOST_METHODS } from './browser-client-host'
import { ALL_RPC_METHODS } from './index'

function request(
  browserHostClientId = 'host-a',
  pageCommandProtocolVersion?: 1,
  pageInventoryProtocolVersion?: 1,
  leaseReconnectProtocolVersion?: 1
) {
  return {
    id: `browser-host:${browserHostClientId}`,
    authToken: 'bound-by-websocket',
    method: 'browser.clientHost.attach',
    params: {
      authorityRuntimeId: 'runtime-a',
      browserHostClientId,
      hostCapabilities: ['webview'],
      ...(pageCommandProtocolVersion ? { pageCommandProtocolVersion } : {}),
      ...(pageInventoryProtocolVersion
        ? { pageInventoryProtocolVersion, pageInventory: [inventoryPage()] }
        : {}),
      ...(leaseReconnectProtocolVersion ? { leaseReconnectProtocolVersion } : {})
    }
  }
}

function runtime(cleanups = new Map<string, () => void>()): OrcaRuntimeService {
  return {
    getRuntimeId: () => 'runtime-a',
    getStartedAt: () => 1,
    // Attach adopts client-hosted pages from the reported inventory before recovery runs.
    resolveBrowserExecutionHostKeyForWorkspace: async () => ({ status: 'workspace-gone' }),
    markClientHostedPagesReconciled: () => {},
    notifyMobileSessionTabsChanged: () => {},
    registerSubscriptionCleanup: (id: string, cleanup: () => void) => cleanups.set(id, cleanup)
  } as unknown as OrcaRuntimeService
}

describe('browser.clientHost.attach RPC', () => {
  it('registers the authenticated client-host methods in production', () => {
    expect(ALL_RPC_METHODS.some((method) => method.name === 'browser.clientHost.attach')).toBe(true)
    expect(
      ALL_RPC_METHODS.some((method) => method.name === 'browser.clientHost.commandResult')
    ).toBe(true)
    expect(
      ALL_RPC_METHODS.some((method) => method.name === 'browser.clientHost.pageMetadata')
    ).toBe(true)
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

  it('echoes and retains only an explicitly negotiated complete page inventory', async () => {
    const cleanups = new Map<string, () => void>()
    const hostRuntime = runtime(cleanups)
    const dispatcher = new RpcDispatcher({
      runtime: hostRuntime,
      methods: BROWSER_CLIENT_HOST_METHODS
    })
    const replies: string[] = []
    const dispatch = dispatcher.dispatchStreaming(
      request('host-a', undefined, 1),
      (reply) => replies.push(reply),
      {
        connectionId: 'connection-a',
        clientKind: 'runtime',
        pairedDeviceId: 'device-a',
        clientCapabilities: [BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY]
      }
    )

    await vi.waitFor(() => expect(replies).toHaveLength(1))
    expect(JSON.parse(replies[0]!).result).toMatchObject({ pageInventoryProtocolVersion: 1 })
    expect(getBrowserHostLeaseRegistry(hostRuntime).select('host-a')).toMatchObject({
      pageInventoryProtocolVersion: 1,
      pageInventory: [inventoryPage()]
    })

    cleanups.get('browser-client-host:host-a')?.()
    await dispatch
  })

  it('publishes one server-owned command and fences result authority', async () => {
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
    const registry = getBrowserHostLeaseRegistry(hostRuntime)
    const lease = registry.select('host-a')
    const placement = registry.placeClientPage('page-a', 'host-a')
    if (placement.kind !== 'client') {
      throw new Error('expected client placement')
    }
    registry.grantExecutionHost(
      {
        authorityEpoch: lease.authorityEpoch,
        browserHostClientId: lease.browserHostClientId,
        browserHostGeneration: lease.browserHostGeneration,
        pairedDeviceId: lease.pairedDeviceId
      },
      'host-key-a'
    )
    const issued = registry.issueClientPageCommand(
      {
        authorityRuntimeId: lease.authorityRuntimeId,
        authorityEpoch: lease.authorityEpoch,
        browserPageId: 'page-a',
        browserHostClientId: lease.browserHostClientId,
        browserHostGeneration: lease.browserHostGeneration,
        pageHostGeneration: placement.pageHostGeneration
      },
      {
        type: 'createPage',
        browserProfileId: 'default',
        executionHostKey: 'host-key-a'
      }
    )
    await vi.waitFor(() => expect(replies).toHaveLength(2))
    expect(JSON.parse(replies[1]!).result).toEqual(issued.event)

    const completed = { ...issued.event, result: { status: 'completed' as const } }
    expect(
      await dispatchCommandResult(dispatcher, completed, { pairedDeviceId: 'device-b' })
    ).toMatchObject({
      ok: false,
      error: { message: 'browser_host_lease_stale' }
    })
    expect(
      await dispatchCommandResult(dispatcher, completed, { connectionId: 'connection-b' })
    ).toMatchObject({
      ok: false,
      error: { message: 'browser_host_lease_stale' }
    })
    const retirement = registry.beginPageRetirement('page-a', placement)
    expect(await dispatchCommandResult(dispatcher, completed)).toMatchObject({
      ok: false,
      error: { message: 'browser_page_retirement_pending' }
    })
    expect(registry.cancelPageRetirement(retirement)).toBe(true)
    expect(
      await dispatchCommandResult(dispatcher, {
        ...completed,
        pageHostGeneration: placement.pageHostGeneration + 1
      })
    ).toMatchObject({
      ok: false,
      error: { message: 'browser_page_placement_stale' }
    })

    expect(await dispatchCommandResult(dispatcher, completed)).toMatchObject({
      ok: true,
      result: { accepted: true }
    })
    await expect(issued.result).resolves.toEqual({ status: 'completed' })
    expect(await dispatchCommandResult(dispatcher, completed)).toMatchObject({
      ok: true,
      result: { accepted: false }
    })
    expect(
      await dispatchCommandResult(dispatcher, {
        ...completed,
        result: { status: 'failed', errorCode: 'different' }
      })
    ).toMatchObject({
      ok: false,
      error: { message: 'browser_host_command_result_conflict' }
    })

    const settledRetirement = registry.beginPageRetirement('page-a', placement)
    expect(registry.completePageRetirement(settledRetirement)).toBe(true)
    expect(await dispatchCommandResult(dispatcher, completed)).toMatchObject({
      ok: false,
      error: { message: 'browser_client_page_placement_required' }
    })

    cleanups.get('browser-client-host:host-a')?.()
    await dispatch
  })

  it('publishes ready before replaying an unsettled command on exact reattach', async () => {
    const cleanups = new Map<string, () => void>()
    const hostRuntime = runtime(cleanups)
    const dispatcher = new RpcDispatcher({
      runtime: hostRuntime,
      methods: BROWSER_CLIENT_HOST_METHODS
    })
    const options = {
      clientKind: 'runtime' as const,
      pairedDeviceId: 'device-a',
      clientCapabilities: [BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY]
    }
    const firstReplies: string[] = []
    const first = dispatcher.dispatchStreaming(
      request('host-a', 1, 1, 1),
      (reply) => firstReplies.push(reply),
      { ...options, connectionId: 'connection-a' }
    )
    await vi.waitFor(() => expect(firstReplies).toHaveLength(1))
    const registry = getBrowserHostLeaseRegistry(hostRuntime)
    const lease = registry.select('host-a')
    const placement = registry.placeClientPage('page-a', 'host-a')
    if (placement.kind !== 'client') {
      throw new Error('expected client placement')
    }
    registry.grantExecutionHost(
      {
        authorityEpoch: lease.authorityEpoch,
        browserHostClientId: lease.browserHostClientId,
        browserHostGeneration: lease.browserHostGeneration,
        pairedDeviceId: lease.pairedDeviceId
      },
      'host-key-a'
    )
    const issued = registry.issueClientPageCommand(
      {
        authorityRuntimeId: lease.authorityRuntimeId,
        authorityEpoch: lease.authorityEpoch,
        browserPageId: 'page-a',
        browserHostClientId: lease.browserHostClientId,
        browserHostGeneration: lease.browserHostGeneration,
        pageHostGeneration: placement.pageHostGeneration
      },
      {
        type: 'createPage',
        browserProfileId: 'default',
        executionHostKey: 'host-key-a'
      }
    )
    await vi.waitFor(() => expect(firstReplies).toHaveLength(2))
    const disconnectFirst = cleanups.get('browser-client-host:host-a')
    disconnectFirst?.()
    await first

    const replacementReplies: string[] = []
    const replacement = dispatcher.dispatchStreaming(
      request('host-a', 1, 1, 1),
      (reply) => replacementReplies.push(reply),
      { ...options, connectionId: 'connection-b' }
    )
    await vi.waitFor(() => expect(replacementReplies).toHaveLength(2))

    expect(JSON.parse(replacementReplies[0]!).result).toMatchObject({
      type: 'ready',
      authorityEpoch: lease.authorityEpoch,
      browserHostGeneration: lease.browserHostGeneration,
      leaseReconnectProtocolVersion: 1
    })
    expect(JSON.parse(replacementReplies[1]!).result).toEqual(issued.event)
    expect(
      await dispatchCommandResult(
        dispatcher,
        { ...issued.event, result: { status: 'completed' } },
        { connectionId: 'connection-b' }
      )
    ).toMatchObject({ ok: true, result: { accepted: true } })
    await expect(issued.result).resolves.toEqual({ status: 'completed' })

    cleanups.get('browser-client-host:host-a')?.()
    await replacement
  })

  it('restores exact authority when reattach reaches the host before old cleanup', async () => {
    const cleanups = new Map<string, () => void>()
    const hostRuntime = runtime(cleanups)
    const dispatcher = new RpcDispatcher({
      runtime: hostRuntime,
      methods: BROWSER_CLIENT_HOST_METHODS
    })
    const options = {
      clientKind: 'runtime' as const,
      pairedDeviceId: 'device-a',
      clientCapabilities: [BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY]
    }
    const firstReplies: string[] = []
    const first = dispatcher.dispatchStreaming(
      request('host-a', 1, 1, 1),
      (reply) => firstReplies.push(reply),
      { ...options, connectionId: 'connection-a' }
    )
    await vi.waitFor(() => expect(firstReplies).toHaveLength(1))
    const firstReady = JSON.parse(firstReplies[0]!).result
    const replacementReplies: string[] = []

    const replacement = dispatcher.dispatchStreaming(
      request('host-a', 1, 1, 1),
      (reply) => replacementReplies.push(reply),
      { ...options, connectionId: 'connection-b' }
    )
    await vi.waitFor(() => expect(replacementReplies).toHaveLength(1))
    await first

    expect(JSON.parse(replacementReplies[0]!).result).toMatchObject({
      type: 'ready',
      authorityEpoch: firstReady.authorityEpoch,
      browserHostGeneration: firstReady.browserHostGeneration
    })
    expect(firstReplies).toHaveLength(1)
    expect(getBrowserHostLeaseRegistry(hostRuntime).select('host-a')).toMatchObject({
      connectionId: 'connection-b',
      browserHostGeneration: firstReady.browserHostGeneration
    })
    cleanups.get('browser-client-host:host-a')?.()
    await replacement
  })

  it('rejects command results from unauthenticated callers', async () => {
    const dispatcher = new RpcDispatcher({
      runtime: runtime(),
      methods: BROWSER_CLIENT_HOST_METHODS
    })

    expect(
      await dispatchCommandResult(dispatcher, unownedCommandResult('runtime-a'), {
        pairedDeviceId: undefined,
        connectionId: undefined
      })
    ).toMatchObject({
      ok: false,
      error: { message: 'authenticated_browser_client_host_required' }
    })
  })

  it('rejects command results from an unnegotiated runtime connection', async () => {
    const dispatcher = new RpcDispatcher({
      runtime: runtime(),
      methods: BROWSER_CLIENT_HOST_METHODS
    })

    expect(
      await dispatchCommandResult(dispatcher, unownedCommandResult('runtime-a'), {
        clientCapabilities: []
      })
    ).toMatchObject({
      ok: false,
      error: { message: 'browser_client_host_capability_required' }
    })
  })

  it('rejects command results addressed to another runtime authority', async () => {
    const dispatcher = new RpcDispatcher({
      runtime: runtime(),
      methods: BROWSER_CLIENT_HOST_METHODS
    })

    expect(
      await dispatchCommandResult(dispatcher, unownedCommandResult('runtime-b'))
    ).toMatchObject({
      ok: false,
      error: { message: 'browser_client_host_authority_mismatch' }
    })
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

async function dispatchCommandResult(
  dispatcher: RpcDispatcher,
  params: Record<string, unknown>,
  overrides: {
    clientKind?: 'runtime' | 'mobile'
    pairedDeviceId?: string
    connectionId?: string
    clientCapabilities?: (typeof BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY)[]
  } = {}
) {
  const replies: string[] = []
  await dispatcher.dispatchStreaming(
    {
      id: 'command-result-a',
      authToken: 'bound-by-websocket',
      method: 'browser.clientHost.commandResult',
      params
    },
    (reply) => replies.push(reply),
    {
      clientKind: 'runtime',
      pairedDeviceId: 'device-a',
      connectionId: 'connection-a',
      clientCapabilities: [BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY],
      ...overrides
    }
  )
  return JSON.parse(replies[0]!)
}

function unownedCommandResult(authorityRuntimeId: string) {
  return {
    pageCommandProtocolVersion: 1,
    authorityRuntimeId,
    authorityEpoch: 'epoch-a',
    browserHostClientId: 'host-a',
    browserHostGeneration: 1,
    browserPageId: 'page-a',
    pageHostGeneration: 1,
    commandSequence: 1,
    commandId: 'command-a',
    result: { status: 'completed' }
  }
}

function inventoryPage() {
  return {
    authorityRuntimeId: 'runtime-a',
    authorityEpoch: 'epoch-old',
    browserHostClientId: 'host-a',
    browserHostGeneration: 2,
    browserPageId: 'page-a',
    pageHostGeneration: 3,
    browserProfileId: 'profile-a',
    executionHostKey: 'native:runtime-a:1',
    state: 'active' as const,
    currentUrl: 'https://remote.internal/'
  }
}
