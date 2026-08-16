import type { BrowserClientHostCommandEvent } from '../../shared/browser-client-host-protocol'
import {
  cleanupBrowserClientPage,
  type BrowserClientPageNetworkRoute as RetainedNetworkRoute,
  type BrowserClientPageRenderer
} from './browser-client-page-cleanup'
import {
  assertBrowserClientPageCommandNotAborted,
  assertCurrentBrowserClientPageRenderer,
  browserClientPageIdentity
} from './browser-client-page-command-admission'
import { BrowserClientPageCommandError } from './browser-client-page-command-failure'
import { createBrowserClientPageInventory } from './browser-client-page-inventory'
import type {
  BrowserClientPageLifecycleRegistry,
  BrowserClientRetainedPage
} from './browser-client-page-retained-state'
import type {
  BrowserRouteGuestLifecycleClaim,
  BrowserRoutePageGuestIdentity
} from './browser-route-page-authority'
import type { BrowserRouteSessionRegistry } from './browser-route-session-registry'
import type { BrowserRouteSessionHandle } from './browser-route-session-state'

type BrowserClientPageCreationDependencies = {
  orcaProfileId: string
  authorityConnectionIdentity: string
  retainNetworkRoute(executionHostKey: string, signal: AbortSignal): Promise<RetainedNetworkRoute>
  selectRenderer(): BrowserClientPageRenderer
  routeSessions: Pick<BrowserRouteSessionRegistry, 'preparePage'>
  routeWebContents: BrowserClientPageLifecycleRegistry
}

export async function createReservedBrowserClientPage(
  dependencies: BrowserClientPageCreationDependencies,
  event: BrowserClientHostCommandEvent,
  signal: AbortSignal,
  assertAvailable: () => void,
  commit: (page: BrowserClientRetainedPage) => void
): Promise<BrowserClientRetainedPage> {
  if (event.command.type !== 'createPage') {
    throw new BrowserClientPageCommandError('browser_client_page_command_invalid')
  }
  assertBrowserClientPageCommandNotAborted(signal)
  let route: RetainedNetworkRoute | null = null
  let routeSession: BrowserRouteSessionHandle | null = null
  let renderer: BrowserClientPageRenderer | null = null
  let registration: BrowserRoutePageGuestIdentity | null = null
  let lifecycleClaim: BrowserRouteGuestLifecycleClaim | null = null
  let mountAttempted = false
  try {
    route = await dependencies.retainNetworkRoute(event.command.executionHostKey, signal)
    if (route.key !== event.command.executionHostKey) {
      throw new BrowserClientPageCommandError('browser_client_page_execution_host_stale')
    }
    assertBrowserClientPageCommandNotAborted(signal)
    assertAvailable()
    renderer = dependencies.selectRenderer()
    assertCurrentBrowserClientPageRenderer(renderer)
    routeSession = await dependencies.routeSessions.preparePage({
      identity: {
        orcaProfileId: dependencies.orcaProfileId,
        browserProfileId: event.command.browserProfileId,
        authorityConnectionIdentity: dependencies.authorityConnectionIdentity,
        executionHostIdentity: route.executionHostIdentity
      },
      browserPageId: event.browserPageId,
      pageHostGeneration: event.pageHostGeneration,
      rendererWebContentsId: renderer.rendererWebContentsId,
      proxyEndpoint: route.proxyEndpoint
    })
    assertBrowserClientPageCommandNotAborted(signal)
    assertAvailable()
    assertCurrentBrowserClientPageRenderer(renderer)
    const page = browserClientPageIdentity(event, routeSession.partition)
    mountAttempted = true
    const mounted = await renderer.mountPage(page, signal)
    registration = {
      ...page,
      rendererWebContentsId: renderer.rendererWebContentsId,
      webContentsId: mounted.webContentsId
    }
    lifecycleClaim = dependencies.routeWebContents.claimGuestLifecycle(registration)
    if (!lifecycleClaim) {
      throw new BrowserClientPageCommandError('browser_client_page_guest_observation_failed')
    }
    assertBrowserClientPageCommandNotAborted(signal)
    assertAvailable()
    assertCurrentBrowserClientPageRenderer(renderer)
    if (!dependencies.routeWebContents.registerGuest(registration)) {
      throw new BrowserClientPageCommandError('browser_client_page_guest_registration_failed')
    }
    if (!dependencies.routeWebContents.grantNavigation(registration)) {
      throw new BrowserClientPageCommandError('browser_client_page_navigation_grant_failed')
    }
    assertAvailable()
    const retainedPage = {
      generation: event.pageHostGeneration,
      inventory: createBrowserClientPageInventory(event, 'active'),
      registration,
      lifecycleClaim,
      renderer,
      route,
      routeSession,
      retiring: null,
      reconciling: false
    }
    commit(retainedPage)
    return retainedPage
  } catch (error) {
    try {
      await cleanupBrowserClientPage(dependencies.routeWebContents, {
        guestMayExist: mountAttempted,
        lifecycleClaim,
        renderer,
        rendererPages: routeSession
          ? [browserClientPageIdentity(event, routeSession.partition)]
          : [],
        route,
        routeSession
      })
    } catch (cleanupError) {
      throw new BrowserClientPageCommandError('browser_client_page_cleanup_failed', {
        cause: new AggregateError([error, cleanupError], 'Browser client page creation failed')
      })
    }
    throw error
  }
}
