import { describe, expect, it, vi } from 'vitest'
import { BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { getBrowserHostLeaseRegistry } from '../../browser-host-lease-registry-instance'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../dispatcher'
import { BROWSER_CLIENT_HOST_METHODS } from './browser-client-host'

describe('browser.clientHost reconciliation negotiation', () => {
  it('echoes and retains reconciliation only for an explicit authenticated request', async () => {
    const cleanups = new Map<string, () => void>()
    const hostRuntime = runtime(cleanups)
    const dispatcher = new RpcDispatcher({
      runtime: hostRuntime,
      methods: BROWSER_CLIENT_HOST_METHODS
    })
    const replies: string[] = []
    const dispatch = dispatcher.dispatchStreaming(
      {
        id: 'browser-host:host-a',
        authToken: 'bound-by-websocket',
        method: 'browser.clientHost.attach',
        params: {
          authorityRuntimeId: 'runtime-a',
          browserHostClientId: 'host-a',
          hostCapabilities: ['webview'],
          pageCommandProtocolVersion: 1,
          pageInventoryProtocolVersion: 1,
          pageInventory: [],
          pageReconciliationProtocolVersion: 1
        }
      },
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
      pageCommandProtocolVersion: 1,
      pageInventoryProtocolVersion: 1,
      pageReconciliationProtocolVersion: 1
    })
    expect(getBrowserHostLeaseRegistry(hostRuntime).select('host-a')).toMatchObject({
      pageReconciliationProtocolVersion: 1
    })

    cleanups.get('browser-client-host:host-a')?.()
    await dispatch
  })

  it('requires exact reconciliation authority on command results', async () => {
    const cleanups = new Map<string, () => void>()
    const hostRuntime = runtime(cleanups)
    const dispatcher = new RpcDispatcher({
      runtime: hostRuntime,
      methods: BROWSER_CLIENT_HOST_METHODS
    })
    const replies: string[] = []
    const dispatch = dispatcher.dispatchStreaming(
      attachRequest(),
      (reply) => replies.push(reply),
      caller()
    )
    await vi.waitFor(() => expect(replies).toHaveLength(1))
    const registry = getBrowserHostLeaseRegistry(hostRuntime)
    const lease = registry.select('host-a')
    const placement = registry.placeClientPage('page-a', 'host-a')
    if (placement.kind !== 'client') {
      throw new Error('expected client placement')
    }
    const identity = {
      authorityEpoch: lease.authorityEpoch,
      browserHostClientId: lease.browserHostClientId,
      browserHostGeneration: lease.browserHostGeneration,
      pairedDeviceId: lease.pairedDeviceId
    }
    registry.grantExecutionHost(identity, 'host-key-a')
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
    expect(issued.event).toMatchObject({ pageReconciliationProtocolVersion: 1 })
    const { pageReconciliationProtocolVersion: _omitted, ...legacyAuthority } = issued.event

    await expect(
      commandResult(dispatcher, { ...legacyAuthority, result: { status: 'completed' } })
    ).resolves.toMatchObject({
      ok: false,
      error: { message: 'browser_host_command_result_authority_stale' }
    })
    await expect(
      commandResult(dispatcher, { ...issued.event, result: { status: 'completed' } })
    ).resolves.toMatchObject({ ok: true, result: { accepted: true } })
    await expect(issued.result).resolves.toEqual({ status: 'completed' })

    cleanups.get('browser-client-host:host-a')?.()
    await dispatch
  })
})

function attachRequest() {
  return {
    id: 'browser-host:host-a',
    authToken: 'bound-by-websocket',
    method: 'browser.clientHost.attach',
    params: {
      authorityRuntimeId: 'runtime-a',
      browserHostClientId: 'host-a',
      hostCapabilities: ['webview'],
      pageCommandProtocolVersion: 1,
      pageInventoryProtocolVersion: 1,
      pageInventory: [],
      pageReconciliationProtocolVersion: 1
    }
  }
}

function caller() {
  return {
    connectionId: 'connection-a',
    clientKind: 'runtime' as const,
    pairedDeviceId: 'device-a',
    clientCapabilities: [BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY]
  }
}

async function commandResult(dispatcher: RpcDispatcher, params: Record<string, unknown>) {
  const replies: string[] = []
  await dispatcher.dispatchStreaming(
    {
      id: 'command-result-a',
      authToken: 'bound-by-websocket',
      method: 'browser.clientHost.commandResult',
      params
    },
    (reply) => replies.push(reply),
    caller()
  )
  return JSON.parse(replies[0]!)
}

function runtime(cleanups: Map<string, () => void>): OrcaRuntimeService {
  return {
    getRuntimeId: () => 'runtime-a',
    getStartedAt: () => 1,
    // Attach adopts client-hosted pages from the reported inventory before recovery runs.
    resolveBrowserExecutionHostKeyForWorkspace: async () => undefined,
    markClientHostedPagesReconciled: () => {},
    registerSubscriptionCleanup: (id: string, cleanup: () => void) => cleanups.set(id, cleanup)
  } as unknown as OrcaRuntimeService
}
