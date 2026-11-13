import type { BrowserClientHostCommandEvent } from '../../../../shared/browser/client-hosting/browser-client-host-protocol'
import { describe, expect, it, vi } from 'vitest'
import { BrowserClientPageCommandExecutor } from '../execution/browser-client-page-command-executor'
import type {
  BrowserRouteGuestLifecycleClaim,
  BrowserRoutePageGuestIdentity
} from '../../routing/guest-authority/browser-route-page-authority'

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
    closePage: {
      type: 'closePage' as const,
      targetAuthority: previousAuthority
    },
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
    pairingAuthorityConnectionIdentity: 'pairing-authority-record-a',
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
