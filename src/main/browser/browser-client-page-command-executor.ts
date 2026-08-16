import {
  BROWSER_CLIENT_HOST_PAGE_INVENTORY_MAX_PAGES,
  type BrowserClientHostedPageInventory,
  type BrowserClientHostCommandEvent,
  type BrowserClientHostCommandResult
} from '../../shared/browser-client-host-protocol'
import { normalizeBrowserNavigationUrl } from '../../shared/browser-url'
import {
  cleanupBrowserClientPage,
  type BrowserClientPageNetworkRoute as RetainedNetworkRoute,
  type BrowserClientPageRenderer,
  type BrowserClientPageRendererIdentity
} from './browser-client-page-cleanup'
import { createReservedBrowserClientPage } from './browser-client-page-creation'
import {
  assertBrowserClientPageCommandNotAborted,
  assertCurrentBrowserClientPageRenderer,
  browserClientPageIdentity
} from './browser-client-page-command-admission'
import type { BrowserRouteSessionRegistry } from './browser-route-session-registry'
import {
  browserClientPageCommandFailureCode,
  BrowserClientPageCommandError,
  isBrowserClientPageCleanupFailure
} from './browser-client-page-command-failure'
import { BrowserClientPageNavigationFence } from './browser-client-page-navigation-fence'
import { executeBrowserClientPageReconciliationCommand } from './browser-client-page-reconciliation'
import type {
  BrowserClientPageLifecycleRegistry,
  BrowserClientRetainedPage
} from './browser-client-page-retained-state'
import {
  createBrowserClientPageInventory,
  snapshotBrowserClientPageInventoryList,
  updateBrowserClientPageInventoryCurrentUrl
} from './browser-client-page-inventory'

type BrowserClientPageCommandExecutorDependencies = {
  orcaProfileId: string
  authorityConnectionIdentity: string
  retainNetworkRoute(executionHostKey: string, signal: AbortSignal): Promise<RetainedNetworkRoute>
  selectRenderer(): BrowserClientPageRenderer
  routeSessions: Pick<BrowserRouteSessionRegistry, 'preparePage'>
  routeWebContents: BrowserClientPageLifecycleRegistry
  maxPages?: number
}

export class BrowserClientPageCommandExecutor {
  private readonly maxPages: number
  private readonly pages = new Map<string, BrowserClientRetainedPage>()
  private readonly creatingPages = new Map<string, BrowserClientHostedPageInventory>()
  private readonly failedPages = new Map<string, BrowserClientHostedPageInventory>()
  private readonly navigationFence = new BrowserClientPageNavigationFence()
  private closePromise: Promise<void> | null = null
  private closed = false

  constructor(private readonly dependencies: BrowserClientPageCommandExecutorDependencies) {
    this.maxPages = dependencies.maxPages ?? BROWSER_CLIENT_HOST_PAGE_INVENTORY_MAX_PAGES
    if (
      !Number.isInteger(this.maxPages) ||
      this.maxPages < 1 ||
      this.maxPages > BROWSER_CLIENT_HOST_PAGE_INVENTORY_MAX_PAGES
    ) {
      throw new Error('browser_client_page_limit_invalid')
    }
  }

  async handle(
    event: BrowserClientHostCommandEvent,
    signal: AbortSignal
  ): Promise<BrowserClientHostCommandResult> {
    if (this.closed || this.navigationFence.isFenced) {
      return { status: 'failed', errorCode: 'browser_client_page_executor_closed' }
    }
    try {
      await this.executeCommand(event, signal)
      return { status: 'completed' }
    } catch (error) {
      return { status: 'failed', errorCode: browserClientPageCommandFailureCode(error, signal) }
    }
  }

  private executeCommand(event: BrowserClientHostCommandEvent, signal: AbortSignal): Promise<void> {
    switch (event.command.type) {
      case 'createPage':
        return this.createPage(event, signal)
      case 'navigate':
        return this.navigate(event, signal)
      case 'reclaimPage':
      case 'closePage':
      case 'restorePage':
        return executeBrowserClientPageReconciliationCommand(
          {
            pages: this.pages,
            failedPages: this.failedPages,
            routeWebContents: this.dependencies.routeWebContents,
            assertAvailable: () => this.navigationFence.assertAvailable(this.closed),
            createPage: (command, commandSignal) => this.createPage(command, commandSignal),
            navigate: (command, commandSignal) => this.navigate(command, commandSignal),
            retirePage: (browserPageId, generation) => this.retirePage(browserPageId, generation),
            cleanupPage: (page, previousRendererPage) =>
              this.cleanupPage(page, previousRendererPage)
          },
          event,
          signal
        )
    }
  }

  hasPage(browserPageId: string, pageHostGeneration: number): boolean {
    return this.pages.get(browserPageId)?.generation === pageHostGeneration
  }

  hasUnresolvedPage(browserPageId: string, pageHostGeneration: number): boolean {
    return this.failedPages.get(browserPageId)?.pageHostGeneration === pageHostGeneration
  }

  snapshotPageInventory(): readonly BrowserClientHostedPageInventory[] {
    return snapshotBrowserClientPageInventoryList(
      this.creatingPages,
      this.pages.values(),
      this.failedPages
    )
  }

  close(): Promise<void> {
    this.closed = true
    return (this.closePromise ??= this.navigationFence.fenceBeforeCleanup(
      this.pages.values(),
      (claim) => this.dependencies.routeWebContents.revokeNavigation(claim),
      () => this.closePages()
    ))
  }

  fenceNavigation(): void {
    this.navigationFence.fence(this.pages.values(), (claim) =>
      this.dependencies.routeWebContents.revokeNavigation(claim)
    )
  }

  async retirePage(browserPageId: string, pageHostGeneration: number): Promise<boolean> {
    const page = this.pages.get(browserPageId)
    if (!page || page.generation !== pageHostGeneration) {
      return false
    }
    page.retiring ??= this.cleanupPage(page)
    try {
      await page.retiring
    } catch (error) {
      if (this.pages.get(browserPageId) === page) {
        this.pages.delete(browserPageId)
      }
      this.failedPages.set(
        browserPageId,
        Object.freeze({ ...page.inventory, state: 'outcomeUnknown' })
      )
      throw error
    }
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
      this.creatingPages.has(event.browserPageId) ||
      this.failedPages.has(event.browserPageId)
    ) {
      throw new BrowserClientPageCommandError('browser_client_page_generation_conflict')
    }
    if (this.pages.size + this.creatingPages.size + this.failedPages.size >= this.maxPages) {
      throw new BrowserClientPageCommandError('browser_client_page_capacity')
    }
    const unknownInventory = createBrowserClientPageInventory(event, 'outcomeUnknown')
    this.creatingPages.set(event.browserPageId, unknownInventory)
    try {
      await this.createReservedPage(event, signal)
    } catch (error) {
      if (isBrowserClientPageCleanupFailure(error)) {
        this.failedPages.set(event.browserPageId, unknownInventory)
      }
      throw error
    } finally {
      this.creatingPages.delete(event.browserPageId)
    }
  }

  private async createReservedPage(
    event: BrowserClientHostCommandEvent,
    signal: AbortSignal
  ): Promise<void> {
    await createReservedBrowserClientPage(
      this.dependencies,
      event,
      signal,
      () => this.navigationFence.assertAvailable(this.closed),
      (page) => this.pages.set(event.browserPageId, page)
    )
  }

  private async navigate(event: BrowserClientHostCommandEvent, signal: AbortSignal): Promise<void> {
    if (event.command.type !== 'navigate') {
      throw new BrowserClientPageCommandError('browser_client_page_command_invalid')
    }
    const page = this.pages.get(event.browserPageId)
    if (
      !page ||
      page.generation !== event.pageHostGeneration ||
      page.retiring ||
      page.reconciling
    ) {
      throw new BrowserClientPageCommandError('browser_client_page_generation_stale')
    }
    assertBrowserClientPageCommandNotAborted(signal)
    assertCurrentBrowserClientPageRenderer(page.renderer)
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
    page.inventory = updateBrowserClientPageInventoryCurrentUrl(page.inventory, normalized)
  }

  private async cleanupPage(
    page: BrowserClientRetainedPage,
    previousRendererPage?: BrowserClientPageRendererIdentity
  ): Promise<void> {
    const currentRendererPage = browserClientPageIdentity(
      page.registration,
      page.registration.partition
    )
    return cleanupBrowserClientPage(this.dependencies.routeWebContents, {
      guestMayExist: true,
      lifecycleClaim: page.lifecycleClaim,
      renderer: page.renderer,
      rendererPages: previousRendererPage
        ? [currentRendererPage, previousRendererPage]
        : [currentRendererPage],
      route: page.route,
      routeSession: page.routeSession
    })
  }

  private async closePages(): Promise<void> {
    const failures: unknown[] = [
      ...(this.creatingPages.size > 0
        ? [new Error('browser_client_page_creation_still_running')]
        : []),
      ...(this.failedPages.size > 0 ? [new Error('browser_client_page_cleanup_unresolved')] : [])
    ]
    for (const [browserPageId, page] of this.pages) {
      try {
        page.retiring ??= this.cleanupPage(page)
        await page.retiring
        if (this.pages.get(browserPageId) === page) {
          this.pages.delete(browserPageId)
        }
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Browser client page executor cleanup failed')
    }
  }
}
