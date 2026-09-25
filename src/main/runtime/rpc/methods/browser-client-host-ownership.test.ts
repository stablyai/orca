import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BrowserClientHostCommandEvent,
  type BrowserClientHostedPageInventory
} from '../../../../shared/browser-client-host-protocol'
import { getBrowserHostLeaseRegistry } from '../../browser-host-lease-registry-instance'
import { OrcaRuntimeService } from '../../orca-runtime'
import { getRuntimeBrowserPageRegistry } from '../../runtime-browser-page-registry'
import { RpcDispatcher } from '../dispatcher'
import { BROWSER_CLIENT_HOST_METHODS } from './browser-client-host'

const hostId = 'host-a'
const deviceId = 'device-a'
const capabilities = ['browser.clientHost.v1', 'browser.clientHost.mobileLease.v1']
const negotiation = {
  hostCapabilities: ['webview', 'automation-v1'],
  supportedAutomationMethods: ['browser.snapshot'] as const,
  pageCommandProtocolVersion: 1 as const,
  pageInventoryProtocolVersion: 1 as const,
  pageReconciliationProtocolVersion: 1 as const,
  leaseReconnectProtocolVersion: 1 as const
}

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup()
  }
  vi.restoreAllMocks()
})

function fixture(clientKind: 'mobile' | 'runtime' = 'mobile') {
  const runtime = new OrcaRuntimeService()
  const registry = getBrowserHostLeaseRegistry(runtime)
  const pages = getRuntimeBrowserPageRegistry(runtime)
  const resolveRoute = vi.spyOn(runtime, 'resolveBrowserExecutionHostKeyForWorkspace')
  const notify = vi.spyOn(runtime, 'notifyMobileSessionTabsChanged')
  const reconcile = vi.spyOn(runtime, 'markClientHostedPagesReconciled')
  const adopt = vi.spyOn(registry, 'adoptClientPages')
  const create = vi.spyOn(registry, 'createClientPage')
  const dispatcher = new RpcDispatcher({ runtime, methods: BROWSER_CLIENT_HOST_METHODS })
  function start(
    pageInventory: readonly BrowserClientHostedPageInventory[],
    pairedDeviceId = deviceId
  ) {
    const signal = new AbortController()
    const replies: unknown[] = []
    const commands: BrowserClientHostCommandEvent[] = []
    const dispatched = dispatcher.dispatchStreaming(
      {
        id: 'attach',
        authToken: 'authenticated-by-transport',
        method: 'browser.clientHost.attach',
        params: {
          ...negotiation,
          authorityRuntimeId: runtime.getRuntimeId(),
          browserHostClientId: hostId,
          pageInventory
        }
      },
      (reply) => {
        const frame = JSON.parse(reply)
        replies.push(frame)
        const parsed = BrowserClientHostCommandEvent.safeParse(frame.result)
        if (parsed.success) {
          commands.push(parsed.data)
          registry.settleClientPageCommand(
            { ...parsed.data, pairedDeviceId, connectionId: 'connection-new' },
            { ...parsed.data, result: { status: 'completed' } }
          )
        }
      },
      {
        clientKind,
        pairedDeviceId,
        connectionId: 'connection-new',
        clientCapabilities: capabilities,
        signal: signal.signal
      }
    )
    cleanups.push(async () => {
      signal.abort()
      await dispatched
      // Replace and release the test lease to clear its reconnect grace timer.
      try {
        const lease = registry.select(hostId)
        registry.attach({ ...lease, leaseReconnectProtocolVersion: undefined }).release()
      } catch {
        // Refused attachment has no lease to release.
      }
    })
    return { replies, commands, dispatched }
  }
  function seedPage() {
    const handle = registry.attach({
      ...negotiation,
      browserHostClientId: hostId,
      clientKind,
      pairedDeviceId: deviceId,
      connectionId: 'connection-old',
      pageInventory: []
    })
    cleanups.push(async () => handle.release())
    const placement = registry.placeClientPage('page-a', hostId)
    if (placement.kind !== 'client') {
      throw new Error('client placement required')
    }
    const page = pages.publishClientPage({
      browserPageId: 'page-a',
      workspaceId: 'folder-workspace',
      browserProfileId: 'default',
      executionHostKey: 'ssh:test:1',
      placement,
      pairedDeviceId: deviceId,
      url: 'https://saved.internal/page',
      loading: false,
      active: true
    })
    const inventory: BrowserClientHostedPageInventory = {
      ...placement,
      authorityRuntimeId: handle.lease.authorityRuntimeId,
      authorityEpoch: handle.lease.authorityEpoch,
      browserPageId: page.browserPageId,
      browserProfileId: page.browserProfileId,
      executionHostKey: page.executionHostKey,
      workspaceId: page.workspaceId,
      currentUrl: page.url,
      state: 'active'
    }
    return { handle, placement, page, inventory }
  }
  return {
    runtime,
    registry,
    pages,
    resolveRoute,
    notify,
    reconcile,
    adopt,
    create,
    start,
    seedPage
  }
}

function predecessorInventory(): BrowserClientHostedPageInventory {
  return {
    authorityRuntimeId: 'predecessor-runtime',
    authorityEpoch: 'predecessor-epoch',
    browserHostClientId: hostId,
    browserHostGeneration: 1,
    browserPageId: 'page-a',
    pageHostGeneration: 1,
    browserProfileId: 'default',
    executionHostKey: 'ssh:test:old',
    workspaceId: 'folder-workspace',
    currentUrl: 'https://saved.internal/page',
    state: 'active'
  }
}

describe('browser host attachment ownership', () => {
  it('refuses initial mobile predecessor inventory before any state mutation', async () => {
    const f = fixture()
    const attach = f.start([predecessorInventory()])
    await attach.dispatched
    expect(attach.replies).toMatchObject([
      { ok: false, error: { message: 'browser_host_page_inventory_authority_mismatch' } }
    ])
    expect(() => f.registry.select(hostId)).toThrow('browser_host_unavailable')
    expect(f.pages.listPages()).toEqual([])
    expect(f.registry.getPlacement('page-a')).toBeUndefined()
    expect(attach.commands).toEqual([])
    expect(f.adopt).not.toHaveBeenCalled()
    expect(f.create).not.toHaveBeenCalled()
    expect(f.resolveRoute).not.toHaveBeenCalled()
    expect(f.notify).not.toHaveBeenCalled()
    expect(f.reconcile).not.toHaveBeenCalled()
  })

  it('refuses predecessor inventory on an existing mobile lease without fencing its pages or grants', async () => {
    const f = fixture()
    const original = f.seedPage()
    const grant = f.registry.grantExecutionHost(original.handle.lease, 'ssh:test:1')
    const delivery = vi.fn()
    f.registry.attachCommandDelivery(original.handle.lease, delivery)
    const pending = f.registry.issueClientPageCommand(original.inventory, {
      type: 'createPage',
      browserProfileId: 'default',
      executionHostKey: 'ssh:test:1'
    })
    const attach = f.start([{ ...original.inventory, authorityRuntimeId: 'predecessor-runtime' }])
    await attach.dispatched
    expect(attach.replies).toMatchObject([
      { ok: false, error: { message: 'browser_page_placement_stale' } }
    ])
    expect(f.registry.select(hostId)).toBe(original.handle.lease)
    expect(f.registry.getPlacement('page-a')).toBe(original.placement)
    expect(f.pages.getPage('page-a')).toBe(original.page)
    expect(() => f.registry.requireExecutionHost(original.handle.lease, 'ssh:test:1')).not.toThrow()
    expect(f.adopt).not.toHaveBeenCalled()
    expect(attach.commands).toEqual([])
    expect(delivery).toHaveBeenCalledOnce()
    expect(
      f.registry.settleClientPageCommand(original.handle.lease, {
        ...pending.event,
        result: { status: 'completed' }
      })
    ).toBe(true)
    await expect(pending.result).resolves.toEqual({ status: 'completed' })
    grant.release()
  })

  it.each(['mobile', 'runtime'] as const)(
    'refuses another device recovering a released desktop host as %s before creating a lease',
    async (clientKind) => {
      const f = fixture(clientKind)
      const desktop = f.registry.attach({
        ...negotiation,
        browserHostClientId: hostId,
        pairedDeviceId: deviceId,
        connectionId: 'desktop-connection',
        pageInventory: []
      })
      const placement = f.registry.placeClientPage('page-a', hostId)
      if (placement.kind !== 'client') {
        throw new Error('client placement required')
      }
      f.pages.publishClientPage({
        browserPageId: 'page-a',
        workspaceId: 'folder-workspace',
        browserProfileId: 'default',
        executionHostKey: 'ssh:test:1',
        placement,
        pairedDeviceId: deviceId,
        url: 'https://saved.internal/page',
        loading: false,
        active: true
      })
      desktop.release()
      const page = f.pages.getPage('page-a')
      f.notify.mockClear()
      const attach = f.start([], 'device-b')
      await attach.dispatched
      expect(attach.replies).toMatchObject([
        { ok: false, error: { message: 'browser_host_identity_conflict' } }
      ])
      expect(() => f.registry.select(hostId)).toThrow('browser_host_unavailable')
      expect(f.pages.getPage('page-a')).toBe(page)
      expect(f.registry.getPlacement('page-a')).toBeUndefined()
      expect(attach.commands).toEqual([])
      expect(f.adopt).not.toHaveBeenCalled()
      expect(f.create).not.toHaveBeenCalled()
      expect(f.notify).not.toHaveBeenCalled()
      expect(f.reconcile).not.toHaveBeenCalled()
    }
  )

  it('preserves an authoritative mobile page and grant on same-device reconnect', async () => {
    const f = fixture()
    const original = f.seedPage()
    const grant = f.registry.grantExecutionHost(original.handle.lease, 'ssh:test:1')
    original.handle.disconnect()
    const attach = f.start([original.inventory])
    await vi.waitFor(() => expect(f.reconcile).toHaveBeenCalled())
    expect(attach.replies).toMatchObject([{ ok: true, result: { type: 'ready' } }])
    const lease = f.registry.select(hostId)
    expect(lease.browserHostGeneration).toBe(original.handle.lease.browserHostGeneration)
    expect(lease.connectionId).toBe('connection-new')
    expect(f.registry.getPlacement('page-a')).toBe(original.placement)
    expect(f.pages.getPage('page-a')).toBe(original.page)
    expect(() => f.registry.requireExecutionHost(lease, 'ssh:test:1')).not.toThrow()
    expect(attach.commands).toEqual([])
    grant.release()
  })

  it('preserves same-device desktop recovery after lease release', async () => {
    const f = fixture('runtime')
    const original = f.seedPage()
    original.handle.release()
    f.notify.mockClear()
    const attach = f.start([])
    await vi.waitFor(() => expect(f.notify).toHaveBeenCalled())
    expect(attach.replies[0]).toMatchObject({ ok: true, result: { type: 'ready' } })
    expect(attach.commands.map((event) => event.command.type)).toEqual(['createPage', 'navigate'])
    expect(f.pages.getPage('page-a')).toMatchObject({
      pairedDeviceId: deviceId,
      url: original.page.url,
      placement: f.registry.getPlacement('page-a')
    })
  })
})
