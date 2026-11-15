import { describe, expect, it, vi } from 'vitest'
import type {
  BrowserClientHostedPageInventory,
  BrowserClientHostCommandEvent
} from '../../../../shared/browser/client-hosting/browser-client-host-protocol'
import { BrowserHostLeaseRegistry } from '../../browser-host/leases/browser-host-lease-registry'
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

/** Exercise attach adoption with real lease/page registries and a client that completes every command. */
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
  // Lease admission already refuses foreign-client inventory; it cannot reach this planner.
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

    // Planning over the full inventory formerly closed declined but still-live client guests.
    expect(closedPageIds(rig.commands)).toEqual(['page-a'])
    expect(rig.leases.getPlacement('x')).toBeUndefined()
  })

  it('restores a legacy empty-address guest after closing its predecessor with the old omitted URL shape', async () => {
    const rig = attach([orphanedPage({ currentUrl: '' })])
    try {
      const result = await rig.adopt()
      expect(result.adoptedPageIds).toEqual(['page-a'])
      expect(rig.commands.map((event) => event.command.type)).toEqual(['closePage', 'restorePage'])
      expect(rig.commands[1].command).not.toHaveProperty('url')
      expect(rig.pages.getPage('page-a')).toBeDefined()
    } finally {
      rig.host.release()
    }
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
})
