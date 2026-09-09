import { describe, expect, it, vi } from 'vitest'
import type {
  BrowserClientHostedPageInventory,
  BrowserClientHostCommandEvent
} from '../../shared/browser-client-host-protocol'
import { BrowserHostLeaseRegistry } from './browser-host-lease-registry'
import { RuntimeBrowserPageRegistry } from './runtime-browser-page-registry'
import {
  adoptRuntimeBrowserClientPagesFromInventory,
  type BrowserExecutionHostKeyResolution
} from './runtime-browser-client-page-adoption'

const AUTHORITY_RUNTIME_ID = 'runtime-new'
const AUTHORITY_EPOCH = 'epoch-new'
const PREDECESSOR_RUNTIME_ID = 'runtime-old'
const HOST_CLIENT_ID = 'host-a'
const WORKSPACE_ID = 'workspace-a'
const EXECUTION_HOST_KEY = 'native:runtime-new:1'

const resolved: BrowserExecutionHostKeyResolution = {
  status: 'resolved',
  executionHostKey: EXECUTION_HOST_KEY
}

function orphanedPage(
  overrides: Partial<BrowserClientHostedPageInventory> = {}
): BrowserClientHostedPageInventory {
  return {
    authorityRuntimeId: PREDECESSOR_RUNTIME_ID,
    authorityEpoch: 'epoch-old',
    browserHostClientId: HOST_CLIENT_ID,
    browserHostGeneration: 4,
    browserPageId: 'page-a',
    pageHostGeneration: 7,
    browserProfileId: 'default',
    executionHostKey: 'native:runtime-old:1',
    state: 'active',
    currentUrl: 'https://remote.internal/left-here',
    workspaceId: WORKSPACE_ID,
    ...overrides
  }
}

/**
 * Drives adoption exactly as the attach handler does, against the real lease registry and page
 * registry, with a client that completes every command it is handed.
 */
function attach(
  pageInventory: readonly BrowserClientHostedPageInventory[],
  options: {
    pages?: RuntimeBrowserPageRegistry
    leases?: BrowserHostLeaseRegistry
    resolveExecutionHostKey?: (workspaceId: string) => Promise<BrowserExecutionHostKeyResolution>
    connectionId?: string
  } = {}
) {
  const leases =
    options.leases ??
    new BrowserHostLeaseRegistry({
      authorityRuntimeId: AUTHORITY_RUNTIME_ID,
      authorityEpoch: AUTHORITY_EPOCH
    })
  const connectionId = options.connectionId ?? 'connection-a'
  const host = leases.attach({
    browserHostClientId: HOST_CLIENT_ID,
    connectionId,
    pairedDeviceId: 'device-a',
    hostCapabilities: ['webview'],
    pageCommandProtocolVersion: 1,
    pageInventoryProtocolVersion: 1,
    pageInventory,
    pageReconciliationProtocolVersion: 1,
    leaseReconnectProtocolVersion: 1
  })
  const identity = {
    authorityEpoch: host.lease.authorityEpoch,
    browserHostClientId: host.lease.browserHostClientId,
    browserHostGeneration: host.lease.browserHostGeneration,
    pairedDeviceId: host.lease.pairedDeviceId
  }
  const commands: BrowserClientHostCommandEvent[] = []
  leases.attachCommandDelivery(identity, (event) => {
    commands.push(event)
    queueMicrotask(() => {
      leases.settleClientPageCommand(
        { ...identity, connectionId },
        { ...event, result: { status: 'completed' } }
      )
    })
  })
  const pages = options.pages ?? new RuntimeBrowserPageRegistry()
  const publishClientPage = vi.spyOn(pages, 'publishClientPage')
  const notifyWorkspace = vi.fn()
  return {
    leases,
    pages,
    host,
    commands,
    publishClientPage,
    notifyWorkspace,
    adopt: () =>
      adoptRuntimeBrowserClientPagesFromInventory({
        lease: host.lease,
        authority: leases,
        pages,
        notifyWorkspace,
        resolveExecutionHostKey:
          options.resolveExecutionHostKey ?? (() => Promise.resolve(resolved))
      })
  }
}

const closedPageIds = (commands: readonly BrowserClientHostCommandEvent[]): string[] =>
  commands.filter((event) => event.command.type === 'closePage').map((event) => event.browserPageId)

describe('adoptRuntimeBrowserClientPagesFromInventory', () => {
  it('republishes a predecessor page under this runtime, inactive and still naming its workspace', async () => {
    const rig = attach([orphanedPage()])

    const result = await rig.adopt()

    expect(result.adoptedPageIds).toEqual(['page-a'])
    expect(result.unadoptedPageIds).toEqual([])
    expect(rig.publishClientPage).toHaveBeenCalledWith(
      expect.objectContaining({
        browserPageId: 'page-a',
        workspaceId: WORKSPACE_ID,
        executionHostKey: EXECUTION_HOST_KEY,
        url: 'https://remote.internal/left-here',
        // Activating here would deactivate whichever sibling the client is actually showing.
        active: false
      })
    )
    expect(rig.pages.getPage('page-a')?.active).toBe(false)
    expect(rig.pages.getPage('page-a')?.workspaceId).toBe(WORKSPACE_ID)
    expect(rig.notifyWorkspace).toHaveBeenCalledWith(WORKSPACE_ID)
  })

  // No row for the "hosted by another client" guard: the lease refuses such an entry at attach
  // (browser_host_page_inventory_authority_mismatch), so it can never reach the planner.
  it.each([
    [
      'a guest whose outcome is unknown',
      orphanedPage({ browserPageId: 'x', state: 'outcomeUnknown' })
    ],
    ['a page with no workspace', orphanedPage({ browserPageId: 'x', workspaceId: undefined })],
    [
      'a page this runtime placed itself',
      orphanedPage({ browserPageId: 'x', authorityRuntimeId: AUTHORITY_RUNTIME_ID })
    ]
  ])('never closes %s that adoption declined', async (_label, declined) => {
    const rig = attach([orphanedPage(), declined])

    await rig.adopt()

    // The bug this pins: planning against the full inventory put every declined entry in the close
    // bucket, so a live guest the client is still showing got a real closePage.
    expect(closedPageIds(rig.commands)).toEqual(['page-a'])
    expect(rig.leases.getPlacement('x')).toBeUndefined()
  })

  it('never closes a page the runtime already tracks', async () => {
    const pages = new RuntimeBrowserPageRegistry()
    const tracked = orphanedPage({ browserPageId: 'page-tracked' })
    const rig = attach([orphanedPage(), tracked], { pages })
    pages.publishClientPage({
      browserPageId: tracked.browserPageId,
      workspaceId: WORKSPACE_ID,
      browserProfileId: 'default',
      executionHostKey: EXECUTION_HOST_KEY,
      placement: {
        kind: 'client',
        browserHostClientId: HOST_CLIENT_ID,
        browserHostGeneration: rig.host.lease.browserHostGeneration,
        pageHostGeneration: 12
      },
      pairedDeviceId: 'device-a',
      url: 'https://remote.internal/tracked',
      loading: false,
      active: false
    })

    await rig.adopt()

    expect(closedPageIds(rig.commands)).toEqual(['page-a'])
    expect(pages.getPage('page-tracked')).toBeDefined()
  })

  it('leaves a page adopted on an earlier attach untouched when the host reconnects', async () => {
    const pages = new RuntimeBrowserPageRegistry()
    const leases = new BrowserHostLeaseRegistry({
      authorityRuntimeId: AUTHORITY_RUNTIME_ID,
      authorityEpoch: AUTHORITY_EPOCH
    })
    const inventory = [orphanedPage()]
    await attach(inventory, { pages, leases }).adopt()
    const adoptedPlacement = leases.getPlacement('page-a')

    // Reconnect still reports the stale entry: the client only rewrites its inventory on republish.
    const second = attach(inventory, { pages, leases, connectionId: 'connection-b' })
    const result = await second.adopt()

    expect(result).toEqual({ adoptedPageIds: [], unadoptedPageIds: [] })
    expect(second.commands).toEqual([])
    expect(leases.getPlacement('page-a')).toEqual(adoptedPlacement)
    expect(pages.getPage('page-a')).toBeDefined()
  })

  it('holds a page whose execution host is not up yet without closing it', async () => {
    const rig = attach([orphanedPage()], {
      resolveExecutionHostKey: () => Promise.resolve({ status: 'unavailable' })
    })

    const result = await rig.adopt()

    expect(result).toEqual({ adoptedPageIds: [], unadoptedPageIds: ['page-a'] })
    expect(rig.commands).toEqual([])
    expect(rig.leases.getPlacement('page-a')).toBeUndefined()
    expect(rig.publishClientPage).not.toHaveBeenCalled()
  })

  it('settles a page whose workspace is gone rather than holding this client open', async () => {
    const rig = attach([orphanedPage()], {
      resolveExecutionHostKey: () => Promise.resolve({ status: 'workspace-gone' })
    })

    const result = await rig.adopt()

    expect(result).toEqual({ adoptedPageIds: [], unadoptedPageIds: [] })
    expect(rig.commands).toEqual([])
  })

  it('reports the unresolvable page as held while adopting its resolvable sibling', async () => {
    const rig = attach(
      [orphanedPage(), orphanedPage({ browserPageId: 'page-b', workspaceId: 'workspace-b' })],
      {
        resolveExecutionHostKey: (workspaceId) =>
          Promise.resolve(workspaceId === WORKSPACE_ID ? resolved : { status: 'unavailable' })
      }
    )

    const result = await rig.adopt()

    expect(result).toEqual({ adoptedPageIds: ['page-a'], unadoptedPageIds: ['page-b'] })
    expect(closedPageIds(rig.commands)).toEqual(['page-a'])
  })

  it('adopts nothing and holds nothing when the host cannot speak the reconciliation protocol', async () => {
    const leases = new BrowserHostLeaseRegistry({
      authorityRuntimeId: AUTHORITY_RUNTIME_ID,
      authorityEpoch: AUTHORITY_EPOCH
    })
    const host = leases.attach({
      browserHostClientId: HOST_CLIENT_ID,
      connectionId: 'connection-a',
      pairedDeviceId: 'device-a',
      hostCapabilities: ['webview']
    })

    await expect(
      adoptRuntimeBrowserClientPagesFromInventory({
        lease: host.lease,
        authority: leases,
        pages: new RuntimeBrowserPageRegistry(),
        notifyWorkspace: vi.fn(),
        resolveExecutionHostKey: () => Promise.resolve(resolved)
      })
    ).resolves.toEqual({ adoptedPageIds: [], unadoptedPageIds: [] })
  })
})
