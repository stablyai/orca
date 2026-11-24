import type { BrowserClientInitializationOwner } from '../../client-hosts/commands/browser-client-host-command-state'
import { BrowserClientExecutorPageCreation } from './browser-client-executor-page-creation'
import { BrowserClientPageInitializations } from './browser-client-page-initializations'
import { BrowserClientPageMetadataParams } from '../../../../shared/browser/client-hosting/browser-client-page-metadata-protocol'
import {
  closeBrowserClientExecutor,
  cleanupBrowserClientExecutorPage
} from './browser-client-page-executor-close'
import { BrowserClientProfileSwitches } from '../lifecycle/browser-client-page-profile-switch'
import { routeBrowserClientPageCommand } from './browser-client-page-command-routing'
import {
  BROWSER_CLIENT_HOST_PAGE_INVENTORY_MAX_PAGES,
  type BrowserClientHostedPageInventory,
  type BrowserClientHostCommandEvent
} from '../../../../shared/browser/client-hosting/browser-client-host-protocol'
import type { BrowserClientAutomationResult as BrowserClientHostCommandResult } from '../../../../shared/browser/client-hosting/browser-client-automation-protocol'
import type { BrowserClientPageRendererIdentity } from '../../../../shared/browser/client-hosting/browser-client-page-renderer-protocol'
import { browserClientPageCommandFailure } from './browser-client-page-command-failure'
import { BrowserClientPageNavigationFence } from '../lifecycle/browser-client-page-navigation-fence'
import { BrowserClientPageMemorySaver } from '../lifecycle/browser-client-page-memory-saver'
import { registerBrowserClientPageMemoryOwner } from '../lifecycle/browser-client-page-memory-registry'
import {
  findBrowserClientPageByWebContentsId,
  retainedBrowserClientPageCookieJar,
  retireBrowserClientRetainedPage,
  type BrowserClientRetainedPage
} from '../lifecycle/browser-client-page-retained-state'
import {
  recordBrowserClientPagePublishedUrl,
  snapshotBrowserClientPageInventoryList
} from '../lifecycle/browser-client-page-inventory'
import {
  pageAuthorityIdentity,
  type BrowserClientPageAuthorityIdentity,
  type BrowserClientPageCommandExecutorDependencies
} from './browser-client-page-command-executor-dependencies'

export class BrowserClientPageCommandExecutor {
  private readonly maxPages: number
  private readonly pages = new Map<string, BrowserClientRetainedPage>()
  private readonly creatingPages = new Map<string, BrowserClientHostedPageInventory>()
  private readonly failedPages = new Map<string, BrowserClientHostedPageInventory>()
  private readonly initializers: BrowserClientPageInitializations
  private readonly profileSwitches = new BrowserClientProfileSwitches()
  private readonly navigationFence = new BrowserClientPageNavigationFence()
  private readonly memorySaver: BrowserClientPageMemorySaver
  private readonly releaseMemoryOwner: () => void
  private closePromise: Promise<void> | null = null
  private closingPageAttempts?: Map<BrowserClientRetainedPage, Promise<void>>
  private authority: BrowserClientPageAuthorityIdentity
  private authorityTransitioning = false
  private closed = false
  private readonly assertAvailable = (): void =>
    this.navigationFence.assertAvailable(this.closed || this.authorityTransitioning)

  constructor(private readonly dependencies: BrowserClientPageCommandExecutorDependencies) {
    this.initializers = new BrowserClientPageInitializations(
      this.pages,
      this.failedPages,
      dependencies.routeWebContents,
      (page) => this.cleanupPage(page)
    )
    this.authority = pageAuthorityIdentity(dependencies)
    this.memorySaver = new BrowserClientPageMemorySaver({
      pages: this.pages,
      failedPages: this.failedPages,
      dependencies,
      authority: () => this.authority,
      isSettled: (browserPageId) =>
        !this.closed &&
        !this.authorityTransitioning &&
        !this.navigationFence.isFenced &&
        !this.initializers.has(browserPageId) &&
        !this.profileSwitches.stagedPages.has(browserPageId),
      assertAvailable: this.assertAvailable,
      cleanupPage: (page) => this.cleanupPage(page)
    })
    this.releaseMemoryOwner = registerBrowserClientPageMemoryOwner(this.memorySaver)
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
    signal: AbortSignal,
    closeInitialization?: BrowserClientInitializationOwner['close']
  ): Promise<BrowserClientHostCommandResult> {
    if (this.closed || this.authorityTransitioning || this.navigationFence.isFenced) {
      return {
        status: 'failed',
        errorCode: 'browser_client_page_executor_closed'
      }
    }
    try {
      if (closeInitialization) {
        return await closeInitialization(signal)
      }
      const value = await this.memorySaver.track(event.browserPageId, async () =>
        (await this.memorySaver.settleCommand(event)) === 'handled'
          ? undefined
          : this.executeCommand(event, signal)
      )
      return value === undefined ? { status: 'completed' } : { status: 'completed', value }
    } catch (error) {
      return browserClientPageCommandFailure(error, signal)
    }
  }

  private executeCommand(
    event: BrowserClientHostCommandEvent,
    signal: AbortSignal
  ): Promise<unknown> {
    return routeBrowserClientPageCommand(
      {
        dependencies: this.dependencies,
        authority: this.authority,
        pages: this.pages,
        failedPages: this.failedPages,
        initializers: this.initializers,
        profileSwitches: this.profileSwitches,
        assertAvailable: this.assertAvailable,
        createPage: (command, commandSignal) => this.createPage(command, commandSignal),
        retirePage: (browserPageId, generation) => this.retirePage(browserPageId, generation),
        cleanupPage: (page, previous, releaseUploads) =>
          this.cleanupPage(page, previous, releaseUploads)
      },
      event,
      signal
    )
  }

  hasPage(browserPageId: string, pageHostGeneration: number): boolean {
    return (
      (this.pages.get(browserPageId)?.generation ??
        this.memorySaver.freed.get(browserPageId)?.inventory.pageHostGeneration) ===
      pageHostGeneration
    )
  }

  hostsPage(browserPageId: string): boolean {
    return (
      !this.closed && (this.pages.has(browserPageId) || this.memorySaver.freed.has(browserPageId))
    )
  }

  pageCookieJar(browserPageId: string) {
    return this.closed ? null : retainedBrowserClientPageCookieJar(this.pages.get(browserPageId))
  }

  hasUnresolvedPage(browserPageId: string, pageHostGeneration: number): boolean {
    return this.failedPages.get(browserPageId)?.pageHostGeneration === pageHostGeneration
  }

  readonly recordPublishedPageUrl = (params: unknown): void => {
    // Only actual initialization owns a requested URL; published pages keep ordinary metadata semantics.
    const parsed = BrowserClientPageMetadataParams.safeParse(params)
    if (!parsed.success || this.initializers.has(parsed.data.browserPageId)) {
      return
    }
    recordBrowserClientPagePublishedUrl(this.pages, parsed.data)
  }

  snapshotPageInventory(): readonly BrowserClientHostedPageInventory[] {
    const freedInventory = [...this.memorySaver.freed].map(
      ([browserPageId, freed]) => [browserPageId, freed.inventory] as const
    )
    return snapshotBrowserClientPageInventoryList(
      new Map([...freedInventory, ...this.creatingPages]),
      this.pages.values(),
      this.failedPages
    )
  }

  close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise
    }
    this.closed = true
    this.closingPageAttempts = new Map()
    this.initializers.cancelAll()
    this.releaseMemoryOwner()
    return (this.closePromise ??= this.navigationFence
      .fenceBeforeCleanup(
        this.profileSwitches.withStagedPages(this.pages.values()),
        (claim) => this.dependencies.routeWebContents.revokeNavigation(claim),
        async () => {
          await this.memorySaver.close()
          return closeBrowserClientExecutor({
            closeInitializations: () => this.initializers.closeAll(),
            profileSwitches: this.profileSwitches,
            creatingPages: this.creatingPages,
            failedPages: this.failedPages,
            pages: this.pages,
            cleanupPage: (page) => this.cleanupPage(page),
            uploadStaging: this.dependencies.uploadStaging
          })
        }
      )
      .finally(() => {
        this.closingPageAttempts = undefined
      }))
  }

  fenceNavigation(): void {
    this.initializers.cancelAll()
    this.navigationFence.fence(this.profileSwitches.withStagedPages(this.pages.values()), (claim) =>
      this.dependencies.routeWebContents.revokeNavigation(claim)
    )
  }

  beginAuthorityTransition(): void {
    if (this.closed || this.authorityTransitioning) {
      throw new Error('browser_client_page_authority_transition_unavailable')
    }
    this.authorityTransitioning = true
    this.initializers.cancelAll()
    this.navigationFence.revoke(
      this.profileSwitches.withStagedPages(this.pages.values()),
      (claim) => this.dependencies.routeWebContents.revokeNavigation(claim)
    )
  }

  completeAuthorityTransition(input: BrowserClientPageAuthorityIdentity): void {
    if (this.closed || !this.authorityTransitioning || !input.authorityConnectionIdentity) {
      throw new Error('browser_client_page_authority_transition_unavailable')
    }
    this.initializers.retireCleanupReceipts()
    this.authority = pageAuthorityIdentity(input)
    this.authorityTransitioning = false
  }

  retirePage(browserPageId: string, pageHostGeneration: number): Promise<boolean> {
    return (
      this.initializers.retirePage(browserPageId, pageHostGeneration) ??
      (this.memorySaver.holds(browserPageId)
        ? this.memorySaver
            .retire(browserPageId, pageHostGeneration)
            .then((retired) => retired ?? this.retireLivePage(browserPageId, pageHostGeneration))
        : this.retireLivePage(browserPageId, pageHostGeneration))
    )
  }

  private retireLivePage(browserPageId: string, pageHostGeneration: number): Promise<boolean> {
    return retireBrowserClientRetainedPage(this.pages, browserPageId, pageHostGeneration, (page) =>
      this.cleanupPage(page)
    )
  }

  private createPage(event: BrowserClientHostCommandEvent, signal: AbortSignal): Promise<void> {
    return new BrowserClientExecutorPageCreation(
      this.dependencies,
      this.authority,
      this.pages,
      this.creatingPages,
      this.failedPages,
      this.memorySaver.freed,
      this.initializers,
      this.maxPages,
      this.assertAvailable,
      (id, generation) => this.retirePage(id, generation)
    ).createPage(event, signal)
  }

  acquireInitialization(event: BrowserClientHostCommandEvent) {
    return this.initializers.acquire(event)
  }

  cancelInitialization(event: BrowserClientHostCommandEvent): boolean {
    return this.initializers.cancel(event)
  }

  findPageByWebContentsId(webContentsId: number): BrowserClientHostedPageInventory | undefined {
    // A staged profile-switch guest already owns its downloads while it loads the page.
    return findBrowserClientPageByWebContentsId(
      this.profileSwitches.withStagedPages(this.pages.values()),
      webContentsId
    )?.inventory
  }

  private cleanupPage(
    page: BrowserClientRetainedPage,
    previousRendererPage?: Readonly<BrowserClientPageRendererIdentity>,
    releaseUploads = true
  ): Promise<void> {
    const closing = this.closingPageAttempts
    const attempt = closing?.get(page)
    if (attempt) {
      return attempt
    }
    const cleanup = cleanupBrowserClientExecutorPage(
      this.dependencies,
      page,
      previousRendererPage,
      releaseUploads
    )
    closing?.set(page, cleanup)
    return cleanup
  }
}
