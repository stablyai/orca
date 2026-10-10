import type { BrowserClientHostCommandEvent } from '../../shared/browser-client-host-protocol'
import { describe, expect, it, vi } from 'vitest'
import { BrowserClientPageCommandExecutor } from './browser-client-page-command-executor'
import type {
  BrowserRouteGuestLifecycleClaim,
  BrowserRoutePageGuestIdentity
} from './browser-route-page-authority'

const partition = `persist:orca-browser-v1-${'a'.repeat(64)}`

function command(
  type: BrowserClientHostCommandEvent['command']['type'],
  overrides: Partial<BrowserClientHostCommandEvent> = {}
): BrowserClientHostCommandEvent {
  const authority =
    type === 'createPage'
      ? {
          authorityRuntimeId: 'runtime-a',
          authorityEpoch: 'epoch-old',
          browserHostGeneration: 2,
          pageHostGeneration: 7
        }
      : {
          authorityRuntimeId: 'runtime-a',
          authorityEpoch: 'epoch-new',
          browserHostGeneration: 3,
          pageHostGeneration: type === 'closePage' ? 7 : 8
        }
  const previousAuthority = {
    authorityRuntimeId: 'runtime-a',
    authorityEpoch: 'epoch-old',
    browserHostClientId: 'client-a',
    browserHostGeneration: 2,
    pageHostGeneration: 7
  }
  const commands = {
    createPage: {
      type: 'createPage' as const,
      browserProfileId: 'profile-a',
      executionHostKey: 'execution-host-a'
    },
    navigate: { type: 'navigate' as const, url: 'https://remote.internal/' },
    reclaimPage: {
      type: 'reclaimPage' as const,
      previousAuthority,
      browserProfileId: 'profile-a',
      executionHostKey: 'execution-host-a'
    },
    closePage: { type: 'closePage' as const, targetAuthority: previousAuthority },
    restorePage: {
      type: 'restorePage' as const,
      browserProfileId: 'profile-a',
      executionHostKey: 'execution-host-a',
      url: 'https://restored.internal/'
    }
  }
  return {
    type: 'command',
    pageCommandProtocolVersion: 1,
    pageReconciliationProtocolVersion: 1,
    browserHostClientId: 'client-a',
    browserPageId: 'page-a',
    commandSequence: 1,
    commandId: `${type}-a`,
    ...authority,
    command: commands[type],
    ...overrides
  } as BrowserClientHostCommandEvent
}

function lifecycleClaim(
  registration: BrowserRoutePageGuestIdentity
): BrowserRouteGuestLifecycleClaim {
  return {
    registration: { ...registration },
    guestAuthority: Symbol('guest-authority'),
    whenDestroyed: Promise.resolve(),
    isCurrent: () => true
  }
}

function createHarness() {
  const route = {
    key: 'execution-host-a',
    executionHostIdentity: 'execution-host-record-a',
    legacyExecutionHostIdentity: 'legacy-execution-host-record-a',
    proxyEndpoint: { host: '127.0.0.1' as const, port: 43123 },
    release: vi.fn()
  }
  const routeSession = { partition, release: vi.fn() }
  const renderer = {
    rendererWebContentsId: 11,
    isCurrent: vi.fn(() => true),
    mountPage: vi.fn(async () => ({ webContentsId: 41 })),
    rekeyPage: vi.fn(async () => {}),
    retirePage: vi.fn()
  }
  const routeWebContents = {
    claimGuestLifecycle: vi.fn((registration: BrowserRoutePageGuestIdentity) =>
      lifecycleClaim(registration)
    ),
    registerGuest: vi.fn(() => true),
    grantNavigation: vi.fn(() => true),
    grantReconciledNavigation: vi.fn(() => true),
    revokeNavigation: vi.fn(() => true),
    navigateGuest: vi.fn(async () => true),
    beginGuestRetirement: vi.fn(() => Promise.resolve()),
    rekeyGuestLifecycle: vi.fn(
      (_claim: BrowserRouteGuestLifecycleClaim, registration: BrowserRoutePageGuestIdentity) => ({
        lifecycleClaim: lifecycleClaim(registration),
        routeSession: { partition, release: vi.fn() }
      })
    )
  }
  const dependencies = {
    orcaProfileId: 'orca-profile-a',
    authorityConnectionIdentity: 'authority-record-a',
    legacyAuthorityConnectionIdentity: 'legacy-authority-record-a',
    storageScope: 'a'.repeat(64),
    retainNetworkRoute: vi.fn(async () => route),
    selectRenderer: vi.fn(() => renderer),
    routeSessions: { preparePage: vi.fn(async () => routeSession) },
    executeAutomation: vi.fn(async () => undefined),
    retireAutomation: vi.fn(async () => {}),
    guestBinding: { bind: vi.fn(), release: vi.fn() },
    routeWebContents
  }
  return {
    dependencies,
    executor: new BrowserClientPageCommandExecutor(dependencies),
    renderer,
    routeWebContents
  }
}

describe('browser client page reconciliation adapters', () => {
  it('reclaims one retained guest by rekeying every exact authority without remounting', async () => {
    const { executor, renderer, routeWebContents } = createHarness()
    await expect(
      executor.handle(command('createPage'), new AbortController().signal)
    ).resolves.toEqual({
      status: 'completed'
    })

    await expect(
      executor.handle(command('reclaimPage'), new AbortController().signal)
    ).resolves.toEqual({
      status: 'completed'
    })

    expect(renderer.mountPage).toHaveBeenCalledOnce()
    expect(renderer.rekeyPage).toHaveBeenCalledWith(
      { partition, browserPageId: 'page-a', pageHostGeneration: 7 },
      { partition, browserPageId: 'page-a', pageHostGeneration: 8 },
      expect.any(AbortSignal)
    )
    expect(routeWebContents.rekeyGuestLifecycle).toHaveBeenCalledOnce()
    expect(executor.snapshotPageInventory()).toEqual([
      expect.objectContaining({
        authorityEpoch: 'epoch-new',
        browserHostGeneration: 3,
        pageHostGeneration: 8,
        state: 'active'
      })
    ])
  })

  it('rejects DOM-preserving reclaim across runtime authorities', async () => {
    const { executor, renderer, routeWebContents } = createHarness()
    await executor.handle(command('createPage'), new AbortController().signal)

    await expect(
      executor.handle(
        command('reclaimPage', { authorityRuntimeId: 'runtime-b' }),
        new AbortController().signal
      )
    ).resolves.toEqual({
      status: 'failed',
      errorCode: 'browser_client_page_reconciliation_authority_stale'
    })

    expect(renderer.rekeyPage).not.toHaveBeenCalled()
    expect(routeWebContents.rekeyGuestLifecycle).not.toHaveBeenCalled()
    expect(executor.hasPage('page-a', 7)).toBe(true)
  })

  it('closes only the exact stale authority and leaves mismatches untouched', async () => {
    const { executor, renderer } = createHarness()
    await executor.handle(command('createPage'), new AbortController().signal)

    await expect(
      executor.handle(
        command('closePage', {
          command: {
            type: 'closePage',
            targetAuthority: {
              authorityRuntimeId: 'runtime-a',
              authorityEpoch: 'different',
              browserHostClientId: 'client-a',
              browserHostGeneration: 2,
              pageHostGeneration: 7
            }
          }
        }),
        new AbortController().signal
      )
    ).resolves.toEqual({
      status: 'failed',
      errorCode: 'browser_client_page_reconciliation_authority_stale'
    })
    expect(executor.hasPage('page-a', 7)).toBe(true)

    await expect(
      executor.handle(command('closePage'), new AbortController().signal)
    ).resolves.toEqual({
      status: 'completed'
    })
    expect(renderer.retirePage).toHaveBeenCalledOnce()
    expect(executor.snapshotPageInventory()).toEqual([])
  })

  it('restores a missing page and its URL only after fresh exact creation', async () => {
    const { executor, renderer, routeWebContents } = createHarness()

    await expect(
      executor.handle(command('restorePage'), new AbortController().signal)
    ).resolves.toEqual({
      status: 'completed'
    })

    expect(renderer.mountPage).toHaveBeenCalledOnce()
    expect(routeWebContents.navigateGuest).toHaveBeenCalledWith(
      expect.any(Object),
      'https://restored.internal/'
    )
    expect(executor.snapshotPageInventory()).toEqual([
      expect.objectContaining({
        authorityEpoch: 'epoch-new',
        browserHostGeneration: 3,
        pageHostGeneration: 8,
        currentUrl: 'https://restored.internal/',
        state: 'active'
      })
    ])
  })

  it('destroys a rekeyed guest instead of restoring authority after renderer failure', async () => {
    const { executor, renderer, routeWebContents } = createHarness()
    await executor.handle(command('createPage'), new AbortController().signal)
    const retainedRendererPages = new Set(['page-a:7', 'page-b:4'])
    renderer.rekeyPage.mockRejectedValueOnce(new Error('renderer outcome unknown'))
    renderer.retirePage.mockImplementation(async (page) => {
      retainedRendererPages.delete(`${page.browserPageId}:${page.pageHostGeneration}`)
    })

    await expect(
      executor.handle(command('reclaimPage'), new AbortController().signal)
    ).resolves.toEqual({
      status: 'failed',
      errorCode: 'browser_client_page_command_failed'
    })

    expect(routeWebContents.revokeNavigation).toHaveBeenCalledOnce()
    expect(routeWebContents.grantNavigation).toHaveBeenCalledOnce()
    expect(routeWebContents.beginGuestRetirement).toHaveBeenCalledOnce()
    expect(renderer.retirePage).toHaveBeenNthCalledWith(1, {
      partition,
      browserPageId: 'page-a',
      pageHostGeneration: 8
    })
    expect(renderer.retirePage).toHaveBeenNthCalledWith(2, {
      partition,
      browserPageId: 'page-a',
      pageHostGeneration: 7
    })
    expect(retainedRendererPages).toEqual(new Set(['page-b:4']))
    expect(executor.snapshotPageInventory()).toEqual([])
  })

  it('removes a fresh restore when its initial navigation cannot be proven', async () => {
    const { executor, renderer, routeWebContents } = createHarness()
    routeWebContents.navigateGuest.mockResolvedValueOnce(false)

    await expect(
      executor.handle(command('restorePage'), new AbortController().signal)
    ).resolves.toEqual({
      status: 'failed',
      errorCode: 'browser_client_page_navigation_failed'
    })

    expect(renderer.retirePage).toHaveBeenCalledOnce()
    expect(routeWebContents.beginGuestRetirement).toHaveBeenCalledOnce()
    expect(executor.snapshotPageInventory()).toEqual([])
  })

  it('destroys a guest rekeyed after abort instead of granting late navigation', async () => {
    const { executor, renderer, routeWebContents } = createHarness()
    await executor.handle(command('createPage'), new AbortController().signal)
    const controller = new AbortController()
    renderer.rekeyPage.mockImplementationOnce(async () => {
      controller.abort(new Error('authority replaced'))
    })

    await expect(executor.handle(command('reclaimPage'), controller.signal)).resolves.toEqual({
      status: 'failed',
      errorCode: 'browser_client_page_command_aborted'
    })

    expect(routeWebContents.grantReconciledNavigation).not.toHaveBeenCalled()
    expect(routeWebContents.beginGuestRetirement).toHaveBeenCalledOnce()
    expect(executor.snapshotPageInventory()).toEqual([])
  })

  it('destroys a guest rekeyed during an authority transition instead of granting navigation', async () => {
    const { executor, renderer, routeWebContents } = createHarness()
    await executor.handle(command('createPage'), new AbortController().signal)
    renderer.rekeyPage.mockImplementationOnce(async () => {
      executor.beginAuthorityTransition()
    })

    await expect(
      executor.handle(command('reclaimPage'), new AbortController().signal)
    ).resolves.toEqual({
      status: 'failed',
      errorCode: 'browser_client_page_executor_closed'
    })

    expect(routeWebContents.grantReconciledNavigation).not.toHaveBeenCalled()
    expect(routeWebContents.beginGuestRetirement).toHaveBeenCalledOnce()
    expect(executor.snapshotPageInventory()).toEqual([])
  })
})
