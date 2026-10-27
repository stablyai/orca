import { closeBrowserClientExecutorPages } from './browser-client-page-executor-close'
import {
  BrowserClientProfileSwitches,
  switchBrowserClientPageProfile
} from './browser-client-page-profile-switch'
import {
  BROWSER_CLIENT_HOST_PAGE_INVENTORY_MAX_PAGES,
  type BrowserClientHostedPageInventory,
  type BrowserClientHostCommandEvent,
  type BrowserClientHostCommandResult
} from '../../shared/browser-client-host-protocol'
import {
  cleanupRetainedBrowserClientPage,
  type BrowserClientPageRendererIdentity
} from './browser-client-page-cleanup'
import { assertBrowserClientPageAdmission } from './browser-client-page-admission'
import { createReservedBrowserClientPage } from './browser-client-page-creation'
import { retireSupersededExecutionHostPages } from './browser-client-page-execution-host-supersession'
import {
  browserClientPageCommandFailureCode,
  BrowserClientPageCommandError,
  isBrowserClientPageCleanupFailure
} from './browser-client-page-command-failure'
import { BrowserClientPageNavigationFence } from './browser-client-page-navigation-fence'
import { executeBrowserClientPageReconciliationCommand } from './browser-client-page-reconciliation'
import {
  findBrowserClientPageByWebContentsId,
  retireBrowserClientRetainedPage,
  type BrowserClientRetainedPage
} from './browser-client-page-retained-state'
import {
  createBrowserClientPageInventory,
  recordBrowserClientPagePublishedUrl,
  snapshotBrowserClientPageInventoryList
} from './browser-client-page-inventory'
import {
  executeBrowserClientPageAutomationCommand,
  navigateBrowserClientPageCommand
} from './browser-client-page-command-execution'
import { publishBrowserClientRetainedPage } from './browser-client-page-availability'
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
  private readonly profileSwitches = new BrowserClientProfileSwitches()
  private readonly navigationFence = new BrowserClientPageNavigationFence()
  private closePromise: Promise<void> | null = null
  private authority: BrowserClientPageAuthorityIdentity
  private authorityTransitioning = false
  private closed = false

  constructor(private readonly dependencies: BrowserClientPageCommandExecutorDependencies) {
    this.authority = pageAuthorityIdentity(dependencies)
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
    if (this.closed || this.authorityTransitioning || this.navigationFence.isFenced) {
      return {
        status: 'failed',
        errorCode: 'browser_client_page_executor_closed'
      }
    }
    try {
      const value = await this.executeCommand(event, signal)
      return value === undefined ? { status: 'completed' } : { status: 'completed', value }
    } catch (error) {
      return {
        status: 'failed',
        errorCode: browserClientPageCommandFailureCode(error, signal)
      }
    }
  }

  private executeCommand(
    event: BrowserClientHostCommandEvent,
    signal: AbortSignal
  ): Promise<unknown> {
    switch (event.command.type) {
      case 'switchProfile':
        return switchBrowserClientPageProfile({
          event,
          signal,
          switches: this.profileSwitches,
          pages: this.pages,
          dependencies: {
            ...this.dependencies,
            ...this.authority
          },
          assertAvailable: () =>
            this.navigationFence.assertAvailable(this.closed || this.authorityTransitioning),
          commit: (page) => publishBrowserClientRetainedPage(this.dependencies, this.pages, page),
          cleanup: (page, releaseUploads) => this.cleanupPage(page, undefined, releaseUploads)
        })
      case 'createPage':
        return this.createPage(event, signal)
      case 'navigate':
        return navigateBrowserClientPageCommand(
          this.pages,
          this.dependencies.routeWebContents,
          event,
          signal
        )
      case 'automation':
        return executeBrowserClientPageAutomationCommand(
          this.pages,
          this.dependencies.executeAutomation,
          event,
          signal,
          {
            transport: this.dependencies.fileChannel,
            staging: this.dependencies.uploadStaging
          }
        )
      case 'reclaimPage':
      case 'closePage':
      case 'restorePage':
        return executeBrowserClientPageReconciliationCommand(
          {
            pages: this.pages,
            failedPages: this.failedPages,
            routeWebContents: this.dependencies.routeWebContents,
            assertAvailable: () =>
              this.navigationFence.assertAvailable(this.closed || this.authorityTransitioning),
            createPage: (command, commandSignal) => this.createPage(command, commandSignal),
            navigate: (command, commandSignal) =>
              navigateBrowserClientPageCommand(
                this.pages,
                this.dependencies.routeWebContents,
                command,
                commandSignal
              ),
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

  hostsPage(browserPageId: string): boolean {
    return !this.closed && this.pages.has(browserPageId)
  }

  hasUnresolvedPage(browserPageId: string, pageHostGeneration: number): boolean {
    return this.failedPages.get(browserPageId)?.pageHostGeneration === pageHostGeneration
  }

  readonly recordPublishedPageUrl = (params: unknown): void =>
    recordBrowserClientPagePublishedUrl(this.pages, params)

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
      this.profileSwitches.withStagedPages(this.pages.values()),
      (claim) => this.dependencies.routeWebContents.revokeNavigation(claim),
      () => this.closePages()
    ))
  }

  fenceNavigation(): void {
    this.navigationFence.fence(this.profileSwitches.withStagedPages(this.pages.values()), (claim) =>
      this.dependencies.routeWebContents.revokeNavigation(claim)
    )
  }

  beginAuthorityTransition(): void {
    if (this.closed || this.authorityTransitioning) {
      throw new Error('browser_client_page_authority_transition_unavailable')
    }
    this.authorityTransitioning = true
    this.navigationFence.revoke(
      this.profileSwitches.withStagedPages(this.pages.values()),
      (claim) => this.dependencies.routeWebContents.revokeNavigation(claim)
    )
  }

  completeAuthorityTransition(input: BrowserClientPageAuthorityIdentity): void {
    if (this.closed || !this.authorityTransitioning || !input.authorityConnectionIdentity) {
      throw new Error('browser_client_page_authority_transition_unavailable')
    }
    this.authority = pageAuthorityIdentity(input)
    this.authorityTransitioning = false
  }

  retirePage(browserPageId: string, pageHostGeneration: number): Promise<boolean> {
    return retireBrowserClientRetainedPage(
      this.pages,
      this.failedPages,
      browserPageId,
      pageHostGeneration,
      (page) => this.cleanupPage(page)
    )
  }

  private async createPage(
    event: BrowserClientHostCommandEvent,
    signal: AbortSignal
  ): Promise<void> {
    if (event.command.type !== 'createPage') {
      throw new BrowserClientPageCommandError('browser_client_page_command_invalid')
    }
    assertBrowserClientPageAdmission(
      [this.pages, this.creatingPages, this.failedPages],
      this.maxPages,
      event.browserPageId
    )
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
      {
        ...this.dependencies,
        ...this.authority,
        retireSupersededExecutionHostPages: (route) =>
          retireSupersededExecutionHostPages(this.pages.values(), route, (id, generation) =>
            this.retirePage(id, generation)
          )
      },
      event,
      signal,
      () => this.navigationFence.assertAvailable(this.closed || this.authorityTransitioning),
      (page) => {
        publishBrowserClientRetainedPage(this.dependencies, this.pages, page)
      }
    )
  }

  findPageByWebContentsId(webContentsId: number): BrowserClientHostedPageInventory | undefined {
    // A staged profile-switch guest already owns its downloads while it loads the page.
    return findBrowserClientPageByWebContentsId(
      this.profileSwitches.withStagedPages(this.pages.values()),
      webContentsId
    )?.inventory
  }

  private async cleanupPage(
    page: BrowserClientRetainedPage,
    previousRendererPage?: BrowserClientPageRendererIdentity,
    releaseUploads = true
  ): Promise<void> {
    page.releaseAvailabilityWatch?.()
    page.releaseAvailabilityWatch = undefined
    this.dependencies.guestBinding.release(page.registration)
    return cleanupRetainedBrowserClientPage(
      page,
      {
        routeWebContents: this.dependencies.routeWebContents,
        retireAutomation: this.dependencies.retireAutomation,
        releaseUploadStaging: async () => {
          if (releaseUploads) {
            await this.dependencies.uploadStaging?.releasePage(page.inventory.browserPageId)
          }
        }
      },
      previousRendererPage
    )
  }

  private closePages(): Promise<void> {
    return closeBrowserClientExecutorPages({
      profileSwitches: this.profileSwitches,
      creatingPages: this.creatingPages,
      failedPages: this.failedPages,
      pages: this.pages,
      cleanupPage: (page) => this.cleanupPage(page),
      uploadStaging: this.dependencies.uploadStaging
    })
  }
}
