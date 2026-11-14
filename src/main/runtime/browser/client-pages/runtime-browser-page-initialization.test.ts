import { expect, it, vi } from 'vitest'
import {
  BROWSER_CLIENT_PAGE_INITIALIZATION_CAPABILITY,
  type BrowserClientHostCommandEvent,
  type BrowserClientHostedPageInventory
} from '../../../../shared/browser/client-hosting/browser-client-host-protocol'
import { BrowserHostLeaseRegistry } from '../../browser-host/leases/browser-host-lease-registry'
import { RuntimeBrowserPageRegistry } from './runtime-browser-page-registry'
import {
  RESTORED_CLIENT_HOSTED_BROWSER_PLACEMENT,
  buildPersistedClientHostedBrowserPages
} from './client-hosted-browser-page-persistence'
import { recoverUnavailableRuntimeBrowserClientPages } from './runtime-browser-client-page-recovery'
import { adoptRuntimeBrowserClientPagesFromInventory } from './runtime-browser-client-page-adoption'
import { retireRuntimeBrowserClientPage } from './browser-client-page-close'

function rig(ids: string[], inventory: BrowserClientHostedPageInventory[] = [], modern = true) {
  const authority = new BrowserHostLeaseRegistry({
    authorityRuntimeId: 'runtime-new',
    authorityEpoch: 'epoch-new'
  })
  const host = authority.attach({
    browserHostClientId: 'host',
    pairedDeviceId: 'device',
    connectionId: 'connection',
    hostCapabilities: [
      'webview',
      'automation',
      ...(modern ? [BROWSER_CLIENT_PAGE_INITIALIZATION_CAPABILITY] : [])
    ],
    pageCommandProtocolVersion: 1,
    pageInventoryProtocolVersion: 1,
    pageReconciliationProtocolVersion: 1,
    pageInventory: inventory
  })
  const pages = new RuntimeBrowserPageRegistry()
  for (const id of ids) {
    pages.publishClientPage({
      browserPageId: id,
      workspaceId: 'workspace',
      browserProfileId: 'default',
      executionHostKey: 'old-key',
      placement: RESTORED_CLIENT_HOSTED_BROWSER_PLACEMENT,
      pairedDeviceId: 'device',
      url: `https://example.test/${id}`,
      loading: false,
      active: false
    })
  }
  const published = new Map(ids.map((id) => [id, Promise.withResolvers<void>()]))
  const navigating = new Map(ids.map((id) => [id, Promise.withResolvers<void>()]))
  const held = new Map<string, BrowserClientHostCommandEvent>()
  const commands: BrowserClientHostCommandEvent[] = []
  const settle = (
    event: BrowserClientHostCommandEvent,
    result: { status: 'completed'; value?: unknown } | { status: 'failed'; errorCode: string }
  ) => {
    authority.settleClientPageCommand({ ...host.lease }, { ...event, result })
  }
  authority.attachCommandDelivery(host.lease, (event) => {
    commands.push(event)
    queueMicrotask(() => {
      if (event.command.type === 'navigate' && event.browserPageId.startsWith('slow')) {
        held.set(event.browserPageId, event)
        navigating.get(event.browserPageId)?.resolve()
      } else {
        if (event.command.type === 'closePage') {
          const pending = held.get(event.browserPageId)
          if (pending) {
            settle(pending, { status: 'failed', errorCode: 'cancelled' })
            held.delete(event.browserPageId)
          }
        }
        settle(event, {
          status: 'completed',
          ...(event.command.type === 'navigate' ? { value: event.command.url } : {})
        })
      }
    })
  })
  const notifyWorkspace = vi.fn(() => {
    for (const [id, done] of published) {
      if (pages.getPage(id)?.placement.pageHostGeneration) {
        done.resolve()
      }
    }
  })
  const options = {
    authority,
    lease: host.lease,
    pages,
    notifyWorkspace,
    resolveExecutionHostKey: async () => ({
      status: 'resolved' as const,
      executionHostKey: 'new-key'
    })
  }
  return {
    ...options,
    host,
    commands,
    published,
    navigating,
    held,
    settle,
    options,
    release(id: string, url = `https://example.test/${id}`) {
      const event = held.get(id)!
      held.delete(id)
      settle(event, { status: 'completed', value: url })
    }
  }
}

it('sibling publication and persistence retain a held saved URL until its own redirect commits', async () => {
  const h = rig(['slow', 'fast'])
  await recoverUnavailableRuntimeBrowserClientPages(h.options)
  h.authority.sealClientPageInitializations(h.host.lease, false)
  await h.navigating.get('slow')!.promise
  await h.published.get('fast')!.promise
  expect(h.pages.getPage('slow')).toMatchObject({
    placement: { pageHostGeneration: 0 },
    url: 'https://example.test/slow'
  })
  expect(buildPersistedClientHostedBrowserPages(h.pages.listPages(), 100)).toContainEqual({
    v: 1,
    browserPageId: 'slow',
    workspaceId: 'workspace',
    browserProfileId: 'default',
    pairedDeviceId: 'device',
    url: 'https://example.test/slow',
    title: 'Browser',
    savedAt: 100
  })
  h.release('slow', 'https://example.test/final')
  await h.published.get('slow')!.promise
  expect(h.pages.getPage('slow')?.url).toBe('https://example.test/final')
  expect(h.authority.getClientPageExecutionHostKey('slow')).toBe('new-key')
  h.host.release()
})

it('a fast imported row and plain recovery publish independently of held adoption with an omitted URL', async () => {
  const inventory = ['slow-adopted', 'fast-adopted'].map(
    (id, index): BrowserClientHostedPageInventory => ({
      authorityRuntimeId: 'runtime-old',
      authorityEpoch: 'epoch-old',
      browserHostClientId: 'host',
      browserHostGeneration: 1,
      browserPageId: id,
      pageHostGeneration: index + 1,
      workspaceId: 'workspace',
      browserProfileId: 'default',
      executionHostKey: 'old-key',
      state: 'outcomeUnknown'
    })
  )
  const h = rig(['slow-adopted', 'fast-adopted', 'recovery'], inventory)
  const adoption = await adoptRuntimeBrowserClientPagesFromInventory(h.options)
  await recoverUnavailableRuntimeBrowserClientPages({
    ...h.options,
    adoptedPageIds: new Set(adoption.adoptedPageIds)
  })
  h.authority.sealClientPageInitializations(h.host.lease, false)
  await h.navigating.get('slow-adopted')!.promise
  await h.published.get('fast-adopted')!.promise
  await h.published.get('recovery')!.promise
  expect(adoption.unadoptedPageIds).toEqual(['slow-adopted', 'fast-adopted'])
  expect(h.pages.getPage('slow-adopted')?.url).toBe('https://example.test/slow-adopted')
  h.release('slow-adopted')
  await h.published.get('slow-adopted')!.promise
  expect(h.authority.getClientPageExecutionHostKey('fast-adopted')).toBe('new-key')
  h.host.release()
})

it('four held initializations keep the next queued and closing one joins cleanup before admitting it', async () => {
  const h = rig(['slow1', 'slow2', 'slow3', 'slow4', 'queued'])
  await recoverUnavailableRuntimeBrowserClientPages(h.options)
  h.authority.sealClientPageInitializations(h.host.lease, false)
  await Promise.all(['slow1', 'slow2', 'slow3', 'slow4'].map((id) => h.navigating.get(id)!.promise))
  expect(h.commands.some((event) => event.browserPageId === 'queued')).toBe(false)
  const host = {
    resolveBrowserWorkspace: async () => ({ id: 'workspace-a' }),
    getBrowserHostLeaseRegistry: () => h.authority,
    getRuntimeBrowserPageRegistry: () => h.pages,
    notifyHeadlessBrowserSessionTabsChanged: h.notifyWorkspace
  }
  await retireRuntimeBrowserClientPage(host, h.pages.getPage('slow1')!)
  expect(h.pages.getPage('slow1')).toBeUndefined()
  await h.published.get('queued')!.promise
  expect(h.authority.getPlacement('slow1')).toBeUndefined()
  expect(h.authority.getClientPageExecutionHostKey('slow1')).toBeUndefined()
  for (const id of ['slow2', 'slow3', 'slow4']) {
    h.release(id)
  }
  await Promise.all(['slow2', 'slow3', 'slow4'].map((id) => h.published.get(id)!.promise))
  h.host.release()
})

it('sanitizes imported and committed canonical addresses before publishing or persisting them', async () => {
  const raw = 'https://kagi.com/search?q=proof&token=YOUR_API_KEY_HERE'
  const h = rig(
    [],
    [
      {
        authorityRuntimeId: 'runtime-old',
        authorityEpoch: 'epoch-old',
        browserHostClientId: 'host',
        browserHostGeneration: 1,
        browserPageId: 'slow-import',
        pageHostGeneration: 1,
        workspaceId: 'workspace',
        browserProfileId: 'default',
        executionHostKey: 'old-key',
        currentUrl: raw,
        state: 'active'
      }
    ]
  )
  const observed: string[] = []
  h.notifyWorkspace.mockImplementation(() => {
    observed.push(...h.pages.listPages().map((page) => page.url))
  })
  try {
    await adoptRuntimeBrowserClientPagesFromInventory(h.options)
    h.authority.sealClientPageInitializations(h.host.lease, false)
    await vi.waitFor(() => expect(h.held.has('slow-import')).toBe(true))
    expect(h.pages.getPage('slow-import')?.url).toBe('https://kagi.com/search?q=proof')
    expect(h.commands.find((event) => event.command.type === 'navigate')?.command).toEqual({
      type: 'navigate',
      url: raw
    })
    h.release('slow-import', raw)
    await vi.waitFor(() =>
      expect(h.pages.getPage('slow-import')?.placement.pageHostGeneration).toBeGreaterThan(0)
    )
    expect(buildPersistedClientHostedBrowserPages(h.pages.listPages(), 100)[0].url).toBe(
      'https://kagi.com/search?q=proof'
    )
    expect(observed.length).toBeGreaterThan(0)
    expect(observed.every((url) => !url.includes('YOUR_API_KEY_HERE'))).toBe(true)
  } finally {
    h.host.release()
  }
})
