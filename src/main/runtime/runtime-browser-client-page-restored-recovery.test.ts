import { describe, expect, it, vi } from 'vitest'
import type { RuntimeBrowserClientPlacement } from '../../shared/runtime-browser-placement'
import {
  RESTORED_CLIENT_HOSTED_BROWSER_PLACEMENT,
  RESTORED_CLIENT_HOSTED_EXECUTION_HOST_KEY
} from './client-hosted-browser-page-persistence'
import { adoptRuntimeBrowserClientPagesFromInventory } from './runtime-browser-client-page-adoption'
import { recoverUnavailableRuntimeBrowserClientPages } from './runtime-browser-client-page-recovery'
import { RuntimeBrowserPageRegistry } from './runtime-browser-page-registry'

const freshPlacement = Object.freeze({
  kind: 'client' as const,
  browserHostClientId: 'host-relaunched',
  browserHostGeneration: 1,
  pageHostGeneration: 1
})

describe('recovery of rehydrated client-hosted pages', () => {
  it('recovers a rehydrated row for the paired device that hosted it, under a fresh placement', async () => {
    const { authority, commands, notifyWorkspace, pages } = harness()

    await recoverUnavailableRuntimeBrowserClientPages({
      lease: lease(),
      authority,
      pages,
      notifyWorkspace,
      resolveExecutionHostKey: resolvesTo('native:runtime-new:2')
    })

    // Nothing to close: the desktop that owned the previous epoch is gone with its runtime.
    expect(commands).toEqual([{ browserPageId: 'page-a', type: 'navigate' }])
    expect(authority.createClientPage).toHaveBeenCalledWith(
      expect.objectContaining({
        browserPageId: 'page-a',
        // The relaunched client's own id and this lease's device, never the persisted record's.
        browserHostClientId: 'host-relaunched',
        pairedDeviceId: 'device-a',
        browserProfileId: 'profile-a',
        // Re-resolved, never replayed: the persisted record carries no route key because a key
        // names the runtime process that minted it.
        executionHostKey: 'native:runtime-new:2'
      })
    )
    expect(pages.getPage('page-a')).toMatchObject({
      placement: freshPlacement,
      executionHostKey: 'native:runtime-new:2',
      url: 'https://restored.internal/',
      loading: false
    })
    expect(notifyWorkspace).toHaveBeenCalledOnce()
  })

  it('leaves a rehydrated row host-absent when another paired device attaches', async () => {
    const { authority, commands, notifyWorkspace, pages } = harness()

    await recoverUnavailableRuntimeBrowserClientPages({
      lease: { ...lease(), pairedDeviceId: 'device-b' },
      authority,
      pages,
      notifyWorkspace,
      resolveExecutionHostKey: resolvesTo('native:runtime-new:2')
    })

    expect(commands).toEqual([])
    expect(authority.createClientPage).not.toHaveBeenCalled()
    // Still listed, still carrying the sentinel: visible to every client and closable by any of them.
    expect(pages.getPage('page-a')?.placement).toEqual(RESTORED_CLIENT_HOSTED_BROWSER_PLACEMENT)
    expect(notifyWorkspace).not.toHaveBeenCalled()
  })

  it('never recovers a rehydrated row whose record names no paired device', async () => {
    const { authority, pages } = harness({ pairedDeviceId: undefined })

    await recoverUnavailableRuntimeBrowserClientPages({
      lease: lease(),
      authority,
      pages,
      notifyWorkspace: vi.fn(),
      resolveExecutionHostKey: resolvesTo('native:runtime-new:2')
    })

    expect(authority.createClientPage).not.toHaveBeenCalled()
  })

  it('leaves a rehydrated row held while its workspace has no route yet', async () => {
    const { authority, pages, notifyWorkspace } = harness()
    const releaseUnrecoverablePage = vi.fn()

    await recoverUnavailableRuntimeBrowserClientPages({
      lease: lease(),
      authority,
      pages,
      notifyWorkspace,
      releaseUnrecoverablePage,
      resolveExecutionHostKey: async () => ({ status: 'unavailable' })
    })

    // "The route is not up yet" is a not-now, never permission to retire the page — the
    // distinction the workspace-gone discriminant exists to make.
    expect(authority.createClientPage).not.toHaveBeenCalled()
    expect(releaseUnrecoverablePage).not.toHaveBeenCalled()
    expect(pages.getPage('page-a')?.placement).toEqual(RESTORED_CLIENT_HOSTED_BROWSER_PLACEMENT)
    expect(notifyWorkspace).not.toHaveBeenCalled()
  })

  it('drops a rehydrated row whose workspace is gone', async () => {
    const { authority, pages } = harness()
    const releaseUnrecoverablePage = vi.fn()

    await recoverUnavailableRuntimeBrowserClientPages({
      lease: lease(),
      authority,
      pages,
      notifyWorkspace: vi.fn(),
      releaseUnrecoverablePage,
      resolveExecutionHostKey: async () => ({ status: 'workspace-gone' })
    })

    expect(authority.createClientPage).not.toHaveBeenCalled()
    expect(releaseUnrecoverablePage).toHaveBeenCalledWith(
      expect.objectContaining({ browserPageId: 'page-a' })
    )
  })

  it('never recovers a rehydrated row without a way to resolve the current route key', async () => {
    const { authority, pages } = harness()
    const releaseUnrecoverablePage = vi.fn()

    await recoverUnavailableRuntimeBrowserClientPages({
      lease: lease(),
      authority,
      pages,
      notifyWorkspace: vi.fn(),
      releaseUnrecoverablePage
    })

    expect(releaseUnrecoverablePage).not.toHaveBeenCalled()

    // Replaying the persisted key is not a fallback: the client answers a predecessor's key with
    // browser_client_network_route_authority_mismatch.
    expect(authority.createClientPage).not.toHaveBeenCalled()
  })

  it('lets adoption take a rehydrated row back when the client still holds the guest', async () => {
    const { pages } = harness()
    const adoptionAuthority = {
      authorityRuntimeId: 'runtime-new',
      authorityEpoch: 'epoch-new',
      getPlacement: vi.fn(() => freshPlacement),
      adoptClientPages: vi.fn(async () => ['page-a'])
    }

    const result = await adoptRuntimeBrowserClientPagesFromInventory({
      lease: adoptionLease(),
      authority: adoptionAuthority,
      pages,
      notifyWorkspace: vi.fn(),
      resolveExecutionHostKey: async () => ({
        status: 'resolved',
        executionHostKey: 'native:runtime-a:1'
      })
    })

    // The persisted record must not shadow a live guest: adoption rekeys the DOM, recovery
    // recreates it, so a row with a guest behind it belongs to adoption.
    expect(result.adoptedPageIds).toEqual(['page-a'])
    expect(pages.getPage('page-a')).toMatchObject({
      placement: freshPlacement,
      url: 'https://client-latest.internal/'
    })
  })
})

function harness(options: { pairedDeviceId?: string } = {}) {
  const pages = new RuntimeBrowserPageRegistry()
  pages.publishClientPage({
    browserPageId: 'page-a',
    workspaceId: 'workspace-a',
    browserProfileId: 'profile-a',
    executionHostKey: RESTORED_CLIENT_HOSTED_EXECUTION_HOST_KEY,
    placement: RESTORED_CLIENT_HOSTED_BROWSER_PLACEMENT,
    ...('pairedDeviceId' in options
      ? options.pairedDeviceId === undefined
        ? {}
        : { pairedDeviceId: options.pairedDeviceId }
      : { pairedDeviceId: 'device-a' }),
    url: 'https://restored.internal/',
    title: 'Restored',
    loading: false,
    active: false
  })
  const commands: { browserPageId: string; type: string }[] = []
  const placements = new Map<string, RuntimeBrowserClientPlacement | undefined>()
  const authority = {
    authorityRuntimeId: 'runtime-new',
    authorityEpoch: 'epoch-new',
    getPlacement: vi.fn((browserPageId: string) => placements.get(browserPageId)),
    beginPageRetirement: vi.fn(
      (browserPageId: string, placement: RuntimeBrowserClientPlacement) => ({
        browserPageId,
        placement
      })
    ),
    completePageRetirement: vi.fn(() => true),
    createClientPage: vi.fn(async (input: { browserPageId: string }) => {
      placements.set(input.browserPageId, freshPlacement)
      return freshPlacement
    }),
    issueClientPageCommand: vi.fn((input: { browserPageId: string }, command: { type: string }) => {
      commands.push({ browserPageId: input.browserPageId, type: command.type })
      return { event: {}, result: Promise.resolve({ status: 'completed' as const }) }
    })
  }
  return { authority, commands, notifyWorkspace: vi.fn(), pages, placements }
}

function resolvesTo(executionHostKey: string) {
  return async () => ({ status: 'resolved' as const, executionHostKey })
}

function lease() {
  return {
    authorityRuntimeId: 'runtime-new',
    authorityEpoch: 'epoch-new',
    browserHostClientId: 'host-relaunched',
    browserHostGeneration: 1,
    pairedDeviceId: 'device-a',
    pageCommandProtocolVersion: 1 as const,
    pageInventoryProtocolVersion: 1 as const,
    pageReconciliationProtocolVersion: 1 as const,
    pageInventory: []
  }
}

function adoptionLease() {
  return {
    ...lease(),
    connectionId: 'conn-a',
    hostCapabilities: [] as readonly string[],
    pageInventory: [
      {
        authorityRuntimeId: 'runtime-old',
        authorityEpoch: 'epoch-old',
        browserHostClientId: 'host-relaunched',
        browserHostGeneration: 1,
        browserPageId: 'page-a',
        pageHostGeneration: 3,
        browserProfileId: 'profile-a',
        executionHostKey: 'native:runtime-a:1',
        workspaceId: 'workspace-a',
        state: 'active' as const,
        currentUrl: 'https://client-latest.internal/'
      }
    ]
  }
}
