import { webContents } from 'electron'
import {
  BROWSER_CLIENT_HOST_PAGE_INVENTORY_URL_MAX_LENGTH,
  type BrowserClientHostedPageInventory,
  type BrowserClientHostCommandEvent
} from '../../../../shared/browser/client-hosting/browser-client-host-protocol'
import { sameBrowserClientPageAuthority } from '../../client-hosts/commands/browser-client-host-command-authority'
import { getBrowserPageIdleDiscard } from '../../guest-lifecycle/browser-page-idle-discard'
import {
  browserGuestShowsFormPost,
  canFreeBrowserGuest
} from '../../guest-lifecycle/browser-guest-freeing'
import type {
  BrowserClientPageAuthorityIdentity,
  BrowserClientPageCommandExecutorDependencies
} from '../execution/browser-client-page-command-executor-dependencies'
import {
  BrowserClientPageCommandError,
  isBrowserClientPageCleanupFailure
} from '../execution/browser-client-page-command-failure'
import { publishBrowserClientRetainedPage } from './browser-client-page-availability'
import { createReservedBrowserClientPage } from './browser-client-page-creation'
import type { BrowserClientPageMemoryOwner } from './browser-client-page-memory-registry'
import { createReconciliationInventory } from './browser-client-page-reconciliation'
import type { BrowserClientRetainedPage } from './browser-client-page-retained-state'

type FreedPage = {
  /** Still reported to the server as active, so it keeps the page's row and placement. */
  inventory: BrowserClientHostedPageInventory & { currentUrl: string }
  createEvent: BrowserClientHostCommandEvent
  retiring: Promise<void>
}

/**
 * Memory Saver for This-device pages: a hidden page's guest is retired on this desktop while the
 * server keeps its page, and the next view or server command remakes it under the same page id
 * and generation at the address it was on. Unlike a local tab it comes back without its
 * back/forward list: route guests load a bootstrap page first, so Electron cannot restore one.
 */
export class BrowserClientPageMemorySaver implements BrowserClientPageMemoryOwner {
  readonly freed = new Map<string, FreedPage>()
  private readonly waking = new Map<string, Promise<void>>()
  private readonly busy = new Map<string, number>()
  private readonly lifetime = new AbortController()

  constructor(
    private readonly host: {
      pages: Map<string, BrowserClientRetainedPage>
      failedPages: Map<string, BrowserClientHostedPageInventory>
      dependencies: BrowserClientPageCommandExecutorDependencies
      authority(): BrowserClientPageAuthorityIdentity
      /** No initialization, profile switch, fence or close owns the page. */
      isSettled(browserPageId: string): boolean
      assertAvailable(): void
      cleanupPage(page: BrowserClientRetainedPage): Promise<void>
    }
  ) {}

  /** A page with a command in flight is in use, whatever its pane shows. */
  async track<T>(browserPageId: string, run: () => Promise<T>): Promise<T> {
    this.busy.set(browserPageId, (this.busy.get(browserPageId) ?? 0) + 1)
    try {
      return await run()
    } finally {
      const remaining = (this.busy.get(browserPageId) ?? 1) - 1
      if (remaining > 0) {
        this.busy.set(browserPageId, remaining)
      } else {
        this.busy.delete(browserPageId)
      }
    }
  }

  ownsGuest(browserPageId: string, guestId: number): boolean {
    return this.host.pages.get(browserPageId)?.registration.webContentsId === guestId
  }

  canFree(browserPageId: string, guest: Electron.WebContents): boolean {
    const page = this.host.pages.get(browserPageId)
    return Boolean(
      page &&
      page.registration.webContentsId === guest.id &&
      !page.retiring &&
      !page.reconciling &&
      page.inventory.state === 'active' &&
      !this.busy.has(browserPageId) &&
      this.host.isSettled(browserPageId) &&
      canFreeBrowserGuest(guest)
    )
  }

  free(browserPageId: string, guest: Electron.WebContents): boolean {
    const page = this.host.pages.get(browserPageId)
    if (!page || !this.canFree(browserPageId, guest)) {
      return false
    }
    const currentUrl = guest.getURL()
    // A POST result would come back as another page; an address too long to report, not at all.
    if (
      browserGuestShowsFormPost(guest) ||
      !currentUrl ||
      currentUrl.length > BROWSER_CLIENT_HOST_PAGE_INVENTORY_URL_MAX_LENGTH
    ) {
      return false
    }
    this.host.pages.delete(browserPageId)
    // Unbound first, so cleanup's release keeps the page's downloads, as a discarded tab's do.
    this.host.dependencies.guestBinding.release(page.registration, 'guest-destroyed')
    const scheduler = getBrowserPageIdleDiscard()
    scheduler.retired(browserPageId, guest.id)
    guest.once('destroyed', () => scheduler.destroyed(browserPageId, guest.id))
    const retiring = this.host.cleanupPage(page)
    const freed = {
      inventory: Object.freeze({ ...page.inventory, currentUrl }),
      createEvent: page.createEvent,
      retiring
    }
    this.freed.set(browserPageId, freed)
    retiring.catch(() => {
      // A guest that may still run cannot be reported active; the server recovers it instead.
      if (this.freed.get(browserPageId) === freed) {
        this.freed.delete(browserPageId)
        this.host.failedPages.set(
          browserPageId,
          Object.freeze({ ...freed.inventory, state: 'outcomeUnknown' })
        )
      }
    })
    return true
  }

  wake(browserPageId: string): Promise<boolean> | null {
    if (!this.freed.has(browserPageId)) {
      return null
    }
    return this.remake(browserPageId).then(
      () => true,
      () => false
    )
  }

  /** Brings a freed page back before a command that needs its guest; others act on the record. */
  async settleCommand(event: BrowserClientHostCommandEvent): Promise<'handled' | 'continue'> {
    // A view may be remaking the page; once it is back, the command acts on the live page.
    await this.waking.get(event.browserPageId)?.catch(() => {})
    const freed = this.freed.get(event.browserPageId)
    if (!freed) {
      return 'continue'
    }
    switch (event.command.type) {
      case 'closePage': {
        const target = event.command.targetAuthority
        if (
          event.pageHostGeneration !== target.pageHostGeneration ||
          !sameBrowserClientPageAuthority(freed.inventory, target)
        ) {
          throw new BrowserClientPageCommandError(
            'browser_client_page_reconciliation_authority_stale'
          )
        }
        await this.drop(event.browserPageId)
        return 'handled'
      }
      case 'reclaimPage': {
        const { command } = event
        if (
          freed.inventory.authorityRuntimeId !== event.authorityRuntimeId ||
          !sameBrowserClientPageAuthority(freed.inventory, command.previousAuthority) ||
          freed.inventory.browserProfileId !== command.browserProfileId ||
          freed.inventory.executionHostKey !== command.executionHostKey
        ) {
          throw new BrowserClientPageCommandError(
            'browser_client_page_reconciliation_authority_stale'
          )
        }
        // Without a guest a reconnect only renames the page; it stays freed.
        freed.inventory = Object.freeze({
          ...createReconciliationInventory(event, 'active'),
          currentUrl: freed.inventory.currentUrl
        })
        return 'handled'
      }
      case 'createPage':
      case 'restorePage':
        await this.drop(event.browserPageId)
        return 'continue'
      case 'navigate':
      case 'automation':
      case 'switchProfile':
        await this.remake(event.browserPageId)
        return 'continue'
    }
  }

  /** Freed, or being remade from a free. */
  holds(browserPageId: string): boolean {
    return this.freed.has(browserPageId) || this.waking.has(browserPageId)
  }

  /** Forgets a freed page whose generation the server retired; null once it is live again. */
  async retire(browserPageId: string, pageHostGeneration: number): Promise<boolean | null> {
    await this.waking.get(browserPageId)?.catch(() => {})
    const freed = this.freed.get(browserPageId)
    if (!freed) {
      return null
    }
    if (freed.inventory.pageHostGeneration !== pageHostGeneration) {
      return false
    }
    await this.drop(browserPageId)
    return true
  }

  /** A wake still running fails its commit or is cleaned up with the executor's live pages. */
  async close(): Promise<void> {
    this.lifetime.abort()
    const retirings = [...this.freed.values()].map((freed) => freed.retiring)
    this.freed.clear()
    await Promise.allSettled(retirings)
  }

  private remake(browserPageId: string): Promise<void> {
    const freed = this.freed.get(browserPageId)
    if (!freed) {
      return Promise.resolve()
    }
    let waking = this.waking.get(browserPageId)
    if (!waking) {
      waking = this.recreate(browserPageId, freed).finally(() => {
        this.waking.delete(browserPageId)
      })
      this.waking.set(browserPageId, waking)
    }
    return waking
  }

  private async recreate(browserPageId: string, freed: FreedPage): Promise<void> {
    await freed.retiring
    const { inventory } = freed
    const event: BrowserClientHostCommandEvent = {
      ...freed.createEvent,
      authorityRuntimeId: inventory.authorityRuntimeId,
      authorityEpoch: inventory.authorityEpoch,
      browserHostClientId: inventory.browserHostClientId,
      browserHostGeneration: inventory.browserHostGeneration,
      pageHostGeneration: inventory.pageHostGeneration
    }
    let page: BrowserClientRetainedPage
    try {
      page = await createReservedBrowserClientPage(
        {
          ...this.host.dependencies,
          ...this.host.authority(),
          // The same page comes back on the same route; nothing it shares is superseded.
          retireSupersededExecutionHostPages: async () => {}
        },
        event,
        this.lifetime.signal,
        () => this.host.assertAvailable(),
        (created) => {
          if (this.freed.get(browserPageId) !== freed) {
            throw new BrowserClientPageCommandError('browser_client_page_generation_stale')
          }
          this.freed.delete(browserPageId)
          created.inventory = freed.inventory
          publishBrowserClientRetainedPage(this.host.dependencies, this.host.pages, created)
        }
      )
    } catch (error) {
      if (isBrowserClientPageCleanupFailure(error) && this.freed.get(browserPageId) === freed) {
        this.freed.delete(browserPageId)
        this.host.failedPages.set(
          browserPageId,
          Object.freeze({ ...freed.inventory, state: 'outcomeUnknown' })
        )
      }
      throw error
    }
    await this.reopen(page, freed)
  }

  private async reopen(page: BrowserClientRetainedPage, freed: FreedPage): Promise<void> {
    // A failed load leaves the page live on its error, as a local tab whose restore failed; a
    // command that navigates elsewhere still runs.
    const { routeWebContents } = this.host.dependencies
    await routeWebContents.navigateGuest(page.lifecycleClaim, freed.inventory.currentUrl)
    // Navigation settles at did-finish-load; a command sent before did-stop-loading would wait on it.
    const guest = webContents.fromId(page.registration.webContentsId)
    if (guest && !guest.isDestroyed() && guest.isLoadingMainFrame()) {
      await new Promise<void>((resolve) => {
        const { signal } = this.lifetime
        const settle = (): void => {
          guest.off('did-stop-loading', settle)
          guest.off('destroyed', settle)
          signal.removeEventListener('abort', settle)
          resolve()
        }
        guest.on('did-stop-loading', settle)
        guest.on('destroyed', settle)
        signal.addEventListener('abort', settle)
      })
    }
  }

  private async drop(browserPageId: string): Promise<void> {
    const freed = this.freed.get(browserPageId)
    if (!freed) {
      return
    }
    this.freed.delete(browserPageId)
    try {
      await freed.retiring
    } catch (error) {
      // An unfinished cleanup still owes the server an answer, as a page whose free failed does.
      this.host.failedPages.set(
        browserPageId,
        Object.freeze({ ...freed.inventory, state: 'outcomeUnknown' })
      )
      throw error
    }
  }
}
