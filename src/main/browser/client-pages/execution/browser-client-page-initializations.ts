import type { BrowserClientInitializationOwner } from '../../client-hosts/commands/browser-client-host-command-state'
import { normalizeBrowserNavigationUrl } from '../../../../shared/browser-url'
import type {
  BrowserClientHostedPageInventory,
  BrowserClientHostCommandEvent
} from '../../../../shared/browser/client-hosting/browser-client-host-protocol'
import { sameBrowserClientPageAuthority } from '../../client-hosts/commands/browser-client-host-command-authority'
import type {
  BrowserClientRetainedPage,
  BrowserClientPageLifecycleRegistry
} from '../lifecycle/browser-client-page-retained-state'
import { updateBrowserClientPageInventoryCurrentUrl } from '../lifecycle/browser-client-page-inventory'
import { assertBrowserClientPageCommandNotAborted } from './browser-client-page-command-admission'
import { BrowserClientPageCommandError } from './browser-client-page-command-failure'

export type PageInitialization = {
  identity: Pick<
    BrowserClientHostCommandEvent,
    | 'authorityRuntimeId'
    | 'authorityEpoch'
    | 'browserHostClientId'
    | 'browserHostGeneration'
    | 'pageHostGeneration'
    | 'browserPageId'
  >
  event?: BrowserClientHostCommandEvent
  controller?: AbortController
  creation?: Promise<void>
  page?: BrowserClientRetainedPage
  failedCleanup?: () => Promise<void>
  cleaned?: boolean
}

export class BrowserClientPageInitializations {
  private readonly operations = new Map<string, PageInitialization>()

  constructor(
    private readonly pages: Map<string, BrowserClientRetainedPage>,
    private readonly failedPages: Map<string, BrowserClientHostedPageInventory>,
    private readonly routeWebContents: BrowserClientPageLifecycleRegistry,
    private readonly cleanupPage: (page: BrowserClientRetainedPage) => Promise<void>
  ) {}

  has(browserPageId: string): boolean {
    const initializer = this.operations.get(browserPageId)
    return initializer !== undefined && !initializer.cleaned
  }

  begin(event: BrowserClientHostCommandEvent): PageInitialization | undefined {
    if (event.command.type !== 'createPage' || event.command.initialUrl === undefined) {
      return undefined
    }
    const existing = this.operations.get(event.browserPageId)
    if (
      existing &&
      sameBrowserClientPageAuthority(existing.identity, event) &&
      existing.identity.pageHostGeneration === event.pageHostGeneration
    ) {
      return existing
    }
    const {
      authorityRuntimeId,
      authorityEpoch,
      browserHostClientId,
      browserHostGeneration,
      pageHostGeneration,
      browserPageId
    } = event
    const initializer = {
      identity: {
        authorityRuntimeId,
        authorityEpoch,
        browserHostClientId,
        browserHostGeneration,
        pageHostGeneration,
        browserPageId
      },
      event,
      controller: new AbortController()
    }
    this.operations.set(event.browserPageId, initializer)
    return initializer
  }

  ownsClose(event: BrowserClientHostCommandEvent): boolean {
    const initializer = this.operations.get(event.browserPageId)
    return Boolean(
      event.command.type === 'closePage' &&
      initializer &&
      sameBrowserClientPageAuthority(initializer.identity, event.command.targetAuthority) &&
      event.pageHostGeneration === initializer.identity.pageHostGeneration
    )
  }

  async creationFailed(initializer: PageInitialization): Promise<void> {
    await this.cleanupInitializer(initializer)
  }

  retireCleanupReceipts(): void {
    for (const [id, initializer] of this.operations) {
      if (initializer.cleaned) {
        this.operations.delete(id)
      }
    }
  }

  acquire(event: BrowserClientHostCommandEvent): BrowserClientInitializationOwner | undefined {
    const initializer = this.begin(event)
    if (!initializer) {
      return undefined
    }
    const browserPageId = initializer.identity.browserPageId
    return {
      isRetired: () => initializer.cleaned === true,
      cancel: (close) => this.operations.get(browserPageId) === initializer && this.cancel(close),
      close: async (signal) => {
        assertBrowserClientPageCommandNotAborted(signal)
        await this.cleanupInitializer(initializer)
        if (this.operations.get(browserPageId) === initializer) {
          this.operations.delete(browserPageId)
        }
        return { status: 'completed' }
      },
      release: () => {
        if (this.operations.get(browserPageId) === initializer) {
          this.operations.delete(browserPageId)
        }
      }
    }
  }

  retirePage(browserPageId: string, pageHostGeneration: number): Promise<boolean> | undefined {
    const initializer = this.operations.get(browserPageId)
    if (initializer?.identity.pageHostGeneration !== pageHostGeneration) {
      return undefined
    }
    initializer.controller?.abort()
    return this.cleanupInitializer(initializer).then(() => true)
  }

  cancel(event: BrowserClientHostCommandEvent): boolean {
    const initializer = this.operations.get(event.browserPageId)
    if (
      event.command.type !== 'closePage' ||
      !initializer ||
      !sameBrowserClientPageAuthority(initializer.identity, event.command.targetAuthority) ||
      event.pageHostGeneration !== initializer.identity.pageHostGeneration
    ) {
      return false
    }
    initializer.controller?.abort()
    return true
  }

  cancelAll(): void {
    for (const initializer of this.operations.values()) {
      initializer.controller?.abort()
    }
  }

  async initialize(event: BrowserClientHostCommandEvent, signal: AbortSignal): Promise<string> {
    const initializer = this.operations.get(event.browserPageId)
    const page = this.pages.get(event.browserPageId)
    const controller = initializer?.controller
    const bootstrap = initializer?.event
    if (
      event.command.type !== 'navigate' ||
      bootstrap?.command.type !== 'createPage' ||
      !initializer ||
      !controller ||
      !page ||
      initializer.page !== page ||
      !sameBrowserClientPageAuthority(initializer.identity, event) ||
      event.commandSequence !== bootstrap.commandSequence + 1 ||
      normalizeBrowserNavigationUrl(event.command.url) !==
        normalizeBrowserNavigationUrl(bootstrap.command.initialUrl ?? '') ||
      !this.routeWebContents.initializeGuest
    ) {
      throw new BrowserClientPageCommandError('browser_client_page_initialization_stale')
    }
    const combined = AbortSignal.any([signal, controller.signal])
    try {
      const url = await this.routeWebContents.initializeGuest(
        page.lifecycleClaim,
        event.command.url,
        combined
      )
      assertBrowserClientPageCommandNotAborted(combined)
      if (
        this.operations.get(event.browserPageId) !== initializer ||
        this.pages.get(event.browserPageId) !== page ||
        !page.lifecycleClaim.isCurrent()
      ) {
        throw new BrowserClientPageCommandError('browser_client_page_initialization_stale')
      }
      page.inventory = Object.freeze({
        ...updateBrowserClientPageInventoryCurrentUrl(page.inventory, url),
        state: 'active'
      })
      this.operations.delete(event.browserPageId)
      return url
    } catch (error) {
      initializer.controller?.abort()
      await this.cleanupInitializer(initializer)
      throw error
    }
  }

  private async cleanupInitializer(initializer: PageInitialization): Promise<void> {
    await initializer.creation?.catch(() => undefined)
    if (initializer.failedCleanup) {
      await initializer.failedCleanup()
      initializer.failedCleanup = undefined
    }
    const page = initializer.page
    if (page) {
      page.retiring = this.cleanupPage(page)
      await page.retiring
      if (this.pages.get(initializer.identity.browserPageId) === page) {
        this.pages.delete(initializer.identity.browserPageId)
      }
    }
    const failed = this.failedPages.get(initializer.identity.browserPageId)
    if (failed && sameBrowserClientPageAuthority(failed, initializer.identity)) {
      this.failedPages.delete(initializer.identity.browserPageId)
    }
    initializer.cleaned = true
    initializer.event = undefined
    initializer.controller = undefined
    initializer.creation = undefined
    initializer.page = undefined
  }

  async close(event: BrowserClientHostCommandEvent, signal: AbortSignal): Promise<void> {
    const initializer = this.operations.get(event.browserPageId)
    assertBrowserClientPageCommandNotAborted(signal)
    if (!initializer || !this.cancel(event)) {
      throw new BrowserClientPageCommandError('browser_client_page_reconciliation_authority_stale')
    }
    await this.cleanupInitializer(initializer)
    if (this.operations.get(event.browserPageId) === initializer) {
      this.operations.delete(event.browserPageId)
    }
  }

  async closeAll(): Promise<void> {
    const failures: unknown[] = []
    for (const [id, initializer] of this.operations) {
      try {
        await this.cleanupInitializer(initializer)
        if (this.operations.get(id) === initializer) {
          this.operations.delete(id)
        }
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length) {
      throw new AggregateError(failures, 'Browser client initializers cleanup failed')
    }
  }
}
