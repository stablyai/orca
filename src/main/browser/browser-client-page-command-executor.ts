import type {
  BrowserClientHostCommandEvent,
  BrowserClientHostCommandResult
} from '../../shared/browser-client-host-protocol'
import { normalizeBrowserNavigationUrl } from '../../shared/browser-url'
import {
  cleanupBrowserClientPage,
  type BrowserClientPageNetworkRoute as RetainedNetworkRoute,
  type BrowserClientPageRenderer,
  type BrowserClientPageRendererIdentity as RendererPageIdentity
} from './browser-client-page-cleanup'
import type {
  BrowserRouteGuestLifecycleClaim,
  BrowserRoutePageGuestIdentity
} from './browser-route-page-authority'
import type { BrowserRouteSessionRegistry } from './browser-route-session-registry'
import type { BrowserRouteSessionHandle } from './browser-route-session-state'
import type { BrowserRouteWebContentsRegistry } from './browser-route-webcontents-registry'

type BrowserClientPageCommandExecutorDependencies = {
  orcaProfileId: string
  authorityConnectionIdentity: string
  retainNetworkRoute(executionHostKey: string, signal: AbortSignal): Promise<RetainedNetworkRoute>
  selectRenderer(): BrowserClientPageRenderer
  routeSessions: Pick<BrowserRouteSessionRegistry, 'preparePage'>
  routeWebContents: Pick<
    BrowserRouteWebContentsRegistry,
    | 'claimGuestLifecycle'
    | 'registerGuest'
    | 'grantNavigation'
    | 'navigateGuest'
    | 'beginGuestRetirement'
  >
  maxPages?: number
}

type RetainedPage = {
  generation: number
  registration: BrowserRoutePageGuestIdentity
  lifecycleClaim: BrowserRouteGuestLifecycleClaim
  renderer: BrowserClientPageRenderer
  route: RetainedNetworkRoute
  routeSession: BrowserRouteSessionHandle
  retiring: Promise<void> | null
}

export class BrowserClientPageCommandExecutor {
  private readonly maxPages: number
  private readonly pages = new Map<string, RetainedPage>()
  private readonly creatingPageIds = new Set<string>()
  private readonly failedPageIds = new Set<string>()

  constructor(private readonly dependencies: BrowserClientPageCommandExecutorDependencies) {
    this.maxPages = dependencies.maxPages ?? 256
    if (!Number.isInteger(this.maxPages) || this.maxPages < 1) {
      throw new Error('browser_client_page_limit_invalid')
    }
  }

  async handle(
    event: BrowserClientHostCommandEvent,
    signal: AbortSignal
  ): Promise<BrowserClientHostCommandResult> {
    try {
      await (event.command.type === 'createPage'
        ? this.createPage(event, signal)
        : this.navigate(event, signal))
      return { status: 'completed' }
    } catch (error) {
      return { status: 'failed', errorCode: commandFailureCode(error, signal) }
    }
  }

  hasPage(browserPageId: string, pageHostGeneration: number): boolean {
    return this.pages.get(browserPageId)?.generation === pageHostGeneration
  }

  async retirePage(browserPageId: string, pageHostGeneration: number): Promise<boolean> {
    const page = this.pages.get(browserPageId)
    if (!page || page.generation !== pageHostGeneration) {
      return false
    }
    page.retiring ??= this.cleanupPage(page)
    await page.retiring
    if (this.pages.get(browserPageId) === page) {
      this.pages.delete(browserPageId)
    }
    return true
  }

  private async createPage(
    event: BrowserClientHostCommandEvent,
    signal: AbortSignal
  ): Promise<void> {
    if (event.command.type !== 'createPage') {
      throw new BrowserClientPageCommandError('browser_client_page_command_invalid')
    }
    if (
      this.pages.has(event.browserPageId) ||
      this.creatingPageIds.has(event.browserPageId) ||
      this.failedPageIds.has(event.browserPageId)
    ) {
      throw new BrowserClientPageCommandError('browser_client_page_generation_conflict')
    }
    if (this.pages.size + this.creatingPageIds.size + this.failedPageIds.size >= this.maxPages) {
      throw new BrowserClientPageCommandError('browser_client_page_capacity')
    }
    this.creatingPageIds.add(event.browserPageId)
    try {
      await this.createReservedPage(event, signal)
    } catch (error) {
      if (isCleanupFailure(error)) {
        this.failedPageIds.add(event.browserPageId)
      }
      throw error
    } finally {
      this.creatingPageIds.delete(event.browserPageId)
    }
  }

  private async createReservedPage(
    event: BrowserClientHostCommandEvent,
    signal: AbortSignal
  ): Promise<void> {
    if (event.command.type !== 'createPage') {
      throw new BrowserClientPageCommandError('browser_client_page_command_invalid')
    }
    assertNotAborted(signal)
    let route: RetainedNetworkRoute | null = null
    let routeSession: BrowserRouteSessionHandle | null = null
    let renderer: BrowserClientPageRenderer | null = null
    let registration: BrowserRoutePageGuestIdentity | null = null
    let lifecycleClaim: BrowserRouteGuestLifecycleClaim | null = null
    let mountAttempted = false
    try {
      route = await this.dependencies.retainNetworkRoute(event.command.executionHostKey, signal)
      if (route.key !== event.command.executionHostKey) {
        throw new BrowserClientPageCommandError('browser_client_page_execution_host_stale')
      }
      assertNotAborted(signal)
      renderer = this.dependencies.selectRenderer()
      assertCurrentRenderer(renderer)
      routeSession = await this.dependencies.routeSessions.preparePage({
        identity: {
          orcaProfileId: this.dependencies.orcaProfileId,
          browserProfileId: event.command.browserProfileId,
          authorityConnectionIdentity: this.dependencies.authorityConnectionIdentity,
          executionHostIdentity: route.executionHostIdentity
        },
        browserPageId: event.browserPageId,
        pageHostGeneration: event.pageHostGeneration,
        rendererWebContentsId: renderer.rendererWebContentsId,
        proxyEndpoint: route.proxyEndpoint
      })
      assertNotAborted(signal)
      assertCurrentRenderer(renderer)
      const page = pageIdentity(event, routeSession.partition)
      mountAttempted = true
      const mounted = await renderer.mountPage(page, signal)
      registration = {
        ...page,
        rendererWebContentsId: renderer.rendererWebContentsId,
        webContentsId: mounted.webContentsId
      }
      lifecycleClaim = this.dependencies.routeWebContents.claimGuestLifecycle(registration)
      if (!lifecycleClaim) {
        throw new BrowserClientPageCommandError('browser_client_page_guest_observation_failed')
      }
      assertNotAborted(signal)
      assertCurrentRenderer(renderer)
      if (!this.dependencies.routeWebContents.registerGuest(registration)) {
        throw new BrowserClientPageCommandError('browser_client_page_guest_registration_failed')
      }
      if (!this.dependencies.routeWebContents.grantNavigation(registration)) {
        throw new BrowserClientPageCommandError('browser_client_page_navigation_grant_failed')
      }
      this.pages.set(event.browserPageId, {
        generation: event.pageHostGeneration,
        registration,
        lifecycleClaim,
        renderer,
        route,
        routeSession,
        retiring: null
      })
    } catch (error) {
      try {
        await cleanupBrowserClientPage(this.dependencies.routeWebContents, {
          guestMayExist: mountAttempted,
          lifecycleClaim,
          renderer,
          rendererPage: routeSession ? pageIdentity(event, routeSession.partition) : null,
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

  private async navigate(event: BrowserClientHostCommandEvent, signal: AbortSignal): Promise<void> {
    if (event.command.type !== 'navigate') {
      throw new BrowserClientPageCommandError('browser_client_page_command_invalid')
    }
    const page = this.pages.get(event.browserPageId)
    if (!page || page.generation !== event.pageHostGeneration || page.retiring) {
      throw new BrowserClientPageCommandError('browser_client_page_generation_stale')
    }
    assertNotAborted(signal)
    assertCurrentRenderer(page.renderer)
    const normalized = normalizeBrowserNavigationUrl(event.command.url)
    if (!normalized || normalized.startsWith('file:')) {
      throw new BrowserClientPageCommandError('browser_client_page_navigation_invalid')
    }
    const navigated = await this.dependencies.routeWebContents.navigateGuest(
      page.lifecycleClaim,
      normalized
    )
    if (!navigated) {
      throw new BrowserClientPageCommandError('browser_client_page_navigation_failed')
    }
  }

  private async cleanupPage(page: RetainedPage): Promise<void> {
    return cleanupBrowserClientPage(this.dependencies.routeWebContents, {
      guestMayExist: true,
      lifecycleClaim: page.lifecycleClaim,
      renderer: page.renderer,
      rendererPage: pageIdentity(page.registration, page.registration.partition),
      route: page.route,
      routeSession: page.routeSession
    })
  }
}

function pageIdentity(
  page: Pick<BrowserClientHostCommandEvent, 'browserPageId' | 'pageHostGeneration'>,
  partition: string
): RendererPageIdentity {
  return {
    partition,
    browserPageId: page.browserPageId,
    pageHostGeneration: page.pageHostGeneration
  }
}

function assertCurrentRenderer(renderer: BrowserClientPageRenderer): void {
  if (
    !Number.isInteger(renderer.rendererWebContentsId) ||
    renderer.rendererWebContentsId <= 0 ||
    !renderer.isCurrent()
  ) {
    throw new BrowserClientPageCommandError('browser_client_page_renderer_stale')
  }
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new BrowserClientPageCommandError('browser_client_page_command_aborted')
  }
}

function commandFailureCode(error: unknown, signal: AbortSignal): string {
  if (error instanceof BrowserClientPageCommandError) {
    return error.message
  }
  return signal.aborted
    ? 'browser_client_page_command_aborted'
    : 'browser_client_page_command_failed'
}

function isCleanupFailure(error: unknown): boolean {
  return (
    error instanceof BrowserClientPageCommandError &&
    error.message === 'browser_client_page_cleanup_failed'
  )
}

class BrowserClientPageCommandError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
  }
}
