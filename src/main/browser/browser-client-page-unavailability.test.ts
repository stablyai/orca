import { describe, expect, it, vi } from 'vitest'
import type { BrowserClientHostCommandEvent } from '../../shared/browser-client-host-protocol'
import type { BrowserRoutePageGuestIdentity } from './browser-route-page-authority'
import { BrowserClientPageCommandExecutor } from './browser-client-page-command-executor'

const partition = `persist:orca-browser-v1-${'a'.repeat(64)}`
const registration = {
  partition,
  browserPageId: 'page-a',
  pageHostGeneration: 7,
  rendererWebContentsId: 11,
  webContentsId: 41
}

describe('browser client page unavailability', () => {
  it('fences an exact unavailable guest generation and requests reconciliation once', async () => {
    const { executor, onPageUnavailable, reportUnavailable } = harness()
    await executor.handle(createCommand(), new AbortController().signal)

    reportUnavailable({ ...registration, pageHostGeneration: 6 })
    expect(onPageUnavailable).not.toHaveBeenCalled()
    reportUnavailable(registration)
    reportUnavailable(registration)

    expect(onPageUnavailable).toHaveBeenCalledOnce()
    expect(onPageUnavailable).toHaveBeenCalledWith('page-a', 7)
    expect(executor.snapshotPageInventory()).toEqual([
      expect.objectContaining({ browserPageId: 'page-a', state: 'outcomeUnknown' })
    ])
  })

  it('closes an unavailable page after its owning app renderer is gone', async () => {
    const { executor, renderer, reportUnavailable, setRendererCurrent } = harness()
    await executor.handle(createCommand(), new AbortController().signal)
    setRendererCurrent(false)
    reportUnavailable(registration)

    await expect(executor.handle(closeCommand(), new AbortController().signal)).resolves.toEqual({
      status: 'completed'
    })
    expect(renderer.retirePage).not.toHaveBeenCalled()
    expect(executor.snapshotPageInventory()).toEqual([])
  })

  it('releases the page availability watch when the page retires', async () => {
    const { executor, releaseAvailabilityWatch } = harness()
    await executor.handle(createCommand(), new AbortController().signal)
    expect(releaseAvailabilityWatch).not.toHaveBeenCalled()

    await expect(executor.retirePage('page-a', 7)).resolves.toBe(true)

    expect(releaseAvailabilityWatch).toHaveBeenCalledOnce()
  })
})

function harness() {
  let rendererCurrent = true
  let availabilityListener: ((page: BrowserRoutePageGuestIdentity) => void) | null = null
  const releaseAvailabilityWatch = vi.fn(() => {
    availabilityListener = null
  })
  const renderer = {
    rendererWebContentsId: 11,
    isCurrent: vi.fn(() => rendererCurrent),
    mountPage: vi.fn(async () => ({ webContentsId: 41 })),
    retirePage: vi.fn(async () => {})
  }
  const onPageUnavailable = vi.fn()
  const executor = new BrowserClientPageCommandExecutor({
    orcaProfileId: 'profile-a',
    authorityConnectionIdentity: 'authority-a',
    legacyAuthorityConnectionIdentity: 'legacy-authority-a',
    storageScope: 'a'.repeat(64),
    retainNetworkRoute: vi.fn(async () => ({
      key: 'execution-host-a',
      executionHostIdentity: 'execution-host-record-a',
      legacyExecutionHostIdentity: 'legacy-execution-host-record-a',
      proxyEndpoint: { host: '127.0.0.1' as const, port: 43123 },
      release: vi.fn()
    })),
    selectRenderer: () => renderer,
    routeSessions: {
      preparePage: vi.fn(async () => ({ partition, release: vi.fn() }))
    },
    routeWebContents: {
      claimGuestLifecycle: vi.fn((page: BrowserRoutePageGuestIdentity) => ({
        registration: page,
        guestAuthority: Symbol('guest'),
        whenDestroyed: Promise.resolve(),
        isCurrent: () => true
      })),
      registerGuest: vi.fn(() => true),
      grantNavigation: vi.fn(() => true),
      revokeNavigation: vi.fn(() => true),
      navigateGuest: vi.fn(async () => true),
      beginGuestRetirement: vi.fn(() => Promise.resolve()),
      watchPageAvailability: vi.fn((_browserPageId, listener) => {
        availabilityListener = listener
        return releaseAvailabilityWatch
      })
    },
    executeAutomation: vi.fn(async () => ({})),
    retireAutomation: vi.fn(async () => {}),
    guestBinding: { bind: vi.fn(), release: vi.fn() },
    onPageUnavailable
  })
  return {
    executor,
    onPageUnavailable,
    releaseAvailabilityWatch,
    renderer,
    reportUnavailable: (page: BrowserRoutePageGuestIdentity) => availabilityListener?.(page),
    setRendererCurrent: (value: boolean) => {
      rendererCurrent = value
    }
  }
}

function createCommand(): BrowserClientHostCommandEvent {
  return {
    type: 'command',
    authorityRuntimeId: 'runtime-a',
    authorityEpoch: 'epoch-a',
    browserHostClientId: 'client-a',
    browserHostGeneration: 3,
    pageCommandProtocolVersion: 1,
    browserPageId: 'page-a',
    pageHostGeneration: 7,
    commandSequence: 1,
    commandId: 'create-page-a',
    command: {
      type: 'createPage',
      browserProfileId: 'profile-a',
      executionHostKey: 'execution-host-a'
    }
  }
}

function closeCommand(): BrowserClientHostCommandEvent {
  return {
    ...createCommand(),
    pageReconciliationProtocolVersion: 1,
    commandSequence: 2,
    commandId: 'close-page-a',
    command: {
      type: 'closePage',
      targetAuthority: {
        authorityRuntimeId: 'runtime-a',
        authorityEpoch: 'epoch-a',
        browserHostClientId: 'client-a',
        browserHostGeneration: 3,
        pageHostGeneration: 7
      }
    }
  }
}
