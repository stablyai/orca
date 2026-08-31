import type { Session, WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import type { BrowserClientHostCommandEvent } from '../../shared/browser-client-host-protocol'
import { BrowserClientHostCommandDispatcher } from './browser-client-host-command-dispatcher'
import { BrowserClientPageCommandExecutor } from './browser-client-page-command-executor'
import { createBrowserRoutePartitionBindingStoreFake } from './browser-route-partition-binding-store-fake'
import { BrowserRouteSessionRegistry } from './browser-route-session-registry'
import { BrowserRouteWebContentsRegistry } from './browser-route-webcontents-registry'

const partition = `persist:orca-browser-v1-${'b'.repeat(64)}`

describe('BrowserClientPageCommandExecutor integration', () => {
  it('composes exact route, Session, navigation, and spontaneous destroyed cleanup', async () => {
    const routeSession = {
      setProxy: vi.fn(async () => {}),
      closeAllConnections: vi.fn(async () => {}),
      resolveProxy: vi.fn(async () => 'SOCKS5 127.0.0.1:43123')
    }
    const clearPolicies = vi.fn()
    let webContentsRegistry: BrowserRouteWebContentsRegistry | null = null
    const sessionRegistry = new BrowserRouteSessionRegistry({
      derivePartition: () => ({ partition, bindingFingerprint: 'binding-a' }),
      validateProfile: vi.fn(),
      getSession: () => routeSession,
      setupPolicies: vi.fn(),
      clearPolicies,
      retirePageAuthority: (retirement) =>
        webContentsRegistry?.retirePageAuthority(retirement) ?? false,
      bindingStore: createBrowserRoutePartitionBindingStoreFake()
    })
    webContentsRegistry = new BrowserRouteWebContentsRegistry({
      getPartitionForSession: (session) => sessionRegistry.getPartitionForSession(session),
      getPreparedPageAuthority: (page) => sessionRegistry.getPreparedPageAuthority(page),
      rekeyPreparedPage: (previous, next) => sessionRegistry.rekeyPreparedPage(previous, next),
      retirePreparedPage: (page) => sessionRegistry.retirePreparedPage(page),
      retirePreparedPagesOwnedByRenderer: (rendererWebContentsId) =>
        sessionRegistry.retirePreparedPagesOwnedByRenderer(rendererWebContentsId)
    })
    const rekeyGuestLifecycle = vi.spyOn(webContentsRegistry, 'rekeyGuestLifecycle')
    const grantReconciledNavigation = vi.spyOn(webContentsRegistry, 'grantReconciledNavigation')
    const guest = createGuest(routeSession as unknown as Session)
    const routeRelease = vi.fn()
    const rendererRetire = vi.fn(async () => {
      guest.destroy()
    })
    const rendererRekey = vi.fn(async () => {})
    const executor = new BrowserClientPageCommandExecutor({
      orcaProfileId: 'orca-profile-a',
      authorityConnectionIdentity: 'authority-record-a',
      legacyAuthorityConnectionIdentity: 'legacy-authority-record-a',
      storageScope: 'a'.repeat(64),
      retainNetworkRoute: vi.fn(async () => ({
        key: 'execution-host-a',
        executionHostIdentity: 'execution-host-record-a',
        legacyExecutionHostIdentity: 'legacy-execution-host-record-a',
        proxyEndpoint: { host: '127.0.0.1' as const, port: 43123 },
        release: routeRelease
      })),
      selectRenderer: () => ({
        rendererWebContentsId: 11,
        isCurrent: () => true,
        mountPage: async () => {
          expect(webContentsRegistry?.attachGuest(guest.webContents)).toBe(true)
          return { webContentsId: 41 }
        },
        rekeyPage: rendererRekey,
        retirePage: rendererRetire
      }),
      routeSessions: sessionRegistry,
      executeAutomation: vi.fn(async () => undefined),
      retireAutomation: vi.fn(async () => {}),
      guestBinding: { bind: vi.fn(), release: vi.fn() },
      routeWebContents: webContentsRegistry
    })

    await expect(executor.handle(createCommand('createPage'), signal())).resolves.toEqual({
      status: 'completed'
    })
    expect(guest.webContents.setWebRTCIPHandlingPolicy).toHaveBeenCalledWith(
      'disable_non_proxied_udp'
    )
    expect(sessionRegistry.isAllowedPartition(partition)).toBe(true)
    expect(guest.url()).toBe('about:blank')
    await expect(executor.handle(createCommand('navigate'), signal())).resolves.toEqual({
      status: 'completed'
    })
    expect(guest.url()).toBe('https://example.internal/path')

    const reclaim = createCommand('reclaimPage')
    const dispatcher = new BrowserClientHostCommandDispatcher({
      authority: reclaim,
      handler: (event, commandSignal) => executor.handle(event, commandSignal)
    })
    const reclaimed = await dispatcher.dispatch(reclaim)
    expect(rekeyGuestLifecycle).toHaveReturnedWith(expect.any(Object))
    expect(grantReconciledNavigation).toHaveReturnedWith(true)
    expect(reclaimed).toEqual({ status: 'completed' })
    expect(rendererRekey).toHaveBeenCalledOnce()
    expect(executor.hasPage('page-a', 7)).toBe(false)
    expect(executor.hasPage('page-a', 8)).toBe(true)
    expect(executor.snapshotPageInventory()).toEqual([
      expect.objectContaining({
        authorityEpoch: 'epoch-new',
        pageHostGeneration: 8,
        currentUrl: 'https://example.internal/path',
        state: 'active'
      })
    ])

    guest.destroy()
    expect(executor.snapshotPageInventory()).toEqual([
      expect.objectContaining({ browserPageId: 'page-a', state: 'outcomeUnknown' })
    ])
    await expect(executor.retirePage('page-a', 8)).resolves.toBe(true)
    expect(guest.webContents.close).not.toHaveBeenCalled()
    expect(rendererRetire).toHaveBeenCalledOnce()
    expect(routeRelease).toHaveBeenCalledOnce()
    expect(clearPolicies).toHaveBeenCalledOnce()
    expect(sessionRegistry.isAllowedPartition(partition)).toBe(false)
  })
})

function createCommand(
  type: 'createPage' | 'navigate' | 'reclaimPage'
): BrowserClientHostCommandEvent {
  const previousAuthority = {
    authorityRuntimeId: 'runtime-a',
    authorityEpoch: 'epoch-a',
    browserHostClientId: 'client-a',
    browserHostGeneration: 3,
    pageHostGeneration: 7
  }
  return {
    type: 'command',
    authorityRuntimeId: 'runtime-a',
    authorityEpoch: type === 'reclaimPage' ? 'epoch-new' : 'epoch-a',
    browserHostClientId: 'client-a',
    browserHostGeneration: type === 'reclaimPage' ? 4 : 3,
    pageCommandProtocolVersion: 1,
    pageReconciliationProtocolVersion: 1,
    browserPageId: 'page-a',
    pageHostGeneration: type === 'reclaimPage' ? 8 : 7,
    commandSequence: type === 'createPage' || type === 'reclaimPage' ? 1 : 2,
    commandId: `${type}-a`,
    command:
      type === 'createPage'
        ? {
            type: 'createPage',
            browserProfileId: 'profile-a',
            executionHostKey: 'execution-host-a'
          }
        : type === 'navigate'
          ? { type: 'navigate', url: 'example.internal/path' }
          : {
              type: 'reclaimPage',
              previousAuthority,
              browserProfileId: 'profile-a',
              executionHostKey: 'execution-host-a'
            }
  }
}

function createGuest(routeSession: Session) {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  let destroyed = false
  let url = 'about:blank'
  const emit = (event: string, ...args: unknown[]): void => {
    for (const listener of listeners.get(event) ?? []) {
      listener(...args)
    }
  }
  const webContents = {
    id: 41,
    session: routeSession,
    hostWebContents: { id: 11 },
    getType: () => 'webview',
    getURL: () => url,
    isDestroyed: () => destroyed,
    close: vi.fn(() => {
      destroyed = true
      emit('destroyed')
    }),
    loadURL: vi.fn(async (nextUrl: string) => {
      const event = { preventDefault: vi.fn() }
      emit('will-navigate', event, nextUrl)
      if (event.preventDefault.mock.calls.length > 0) {
        throw new Error('navigation denied')
      }
      url = nextUrl
    }),
    setWebRTCIPHandlingPolicy: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      const eventListeners = listeners.get(event) ?? new Set()
      eventListeners.add(listener)
      listeners.set(event, eventListeners)
    }),
    off: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      listeners.get(event)?.delete(listener)
    })
  } as unknown as WebContents
  return {
    webContents,
    url: () => url,
    destroy: () => {
      if (!destroyed) {
        destroyed = true
        emit('destroyed')
      }
    }
  }
}

function signal(): AbortSignal {
  return new AbortController().signal
}
