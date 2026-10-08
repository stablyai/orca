import type { BrowserWindow } from 'electron'
import type { BrowserBackendCreateTab } from './browser-backend'
import type { BrowserManager } from './browser-manager'

/** A page currently torn down to reclaim memory, restorable by page id. */
export type SleepingOffscreenPage = {
  url: string
  worktreeId?: string
  profileId?: string
  sleptAt: number
}

export type OffscreenPageInventoryEntry = {
  webContentsId: number
  url: string
  lastActivityAt: number
  hasActiveLease: boolean
}

export type OffscreenPageSleeperPorts = {
  windowsByPageId: Map<string, BrowserWindow>
  retirePageOwner: (browserPageId: string) => Promise<void>
  createTab: (params: BrowserBackendCreateTab) => Promise<{ browserPageId: string }>
  isShuttingDown: () => boolean
}

/**
 * Owns the idle bookkeeping + sleep/restore for serve's offscreen browser
 * pages: the sleeping-page records, their saved navigation history, and the
 * last-activity stamps the sweeper reads. Extracted so the backend file stays
 * focused on window lifecycle.
 */
export class OffscreenPageSleeper {
  private readonly lastActivityByPageId = new Map<string, number>()
  private readonly sleepingByPageId = new Map<string, SleepingOffscreenPage>()
  private readonly sleepingHistoryByPageId = new Map<
    string,
    { entries: Electron.NavigationEntry[]; activeIndex: number }
  >()

  constructor(
    private readonly browserManager: Pick<
      BrowserManager,
      'getWorktreeIdForTab' | 'getSessionProfileIdForTab' | 'unregisterGuest' | 'isPaintLeaseHeld'
    >,
    private readonly ports: OffscreenPageSleeperPorts
  ) {}

  /** Resets the idle clock and consumes any stored sleeping record (createTab is the wake path). */
  onPageCreated(browserPageId: string): void {
    this.lastActivityByPageId.set(browserPageId, Date.now())
    this.sleepingByPageId.delete(browserPageId)
  }

  onPageRemoved(browserPageId: string): void {
    this.lastActivityByPageId.delete(browserPageId)
    this.sleepingByPageId.delete(browserPageId)
  }

  /** True while the page's window is torn down but its id is restorable. */
  isPageSleeping(browserPageId: string): boolean {
    return this.sleepingByPageId.has(browserPageId)
  }

  /** Marks the page recently used so the idle sweep leaves it alone. */
  touchPage(browserPageId: string): void {
    if (this.ports.windowsByPageId.has(browserPageId)) {
      this.lastActivityByPageId.set(browserPageId, Date.now())
    }
  }

  getSleepingPage(browserPageId: string): SleepingOffscreenPage | undefined {
    return this.sleepingByPageId.get(browserPageId)
  }

  listSleepingPageIds(): string[] {
    return [...this.sleepingByPageId.keys()]
  }

  /** Live offscreen pages for the idle sweeper; sleeping pages have no window so are absent. */
  listPageInventory(): Map<string, OffscreenPageInventoryEntry> {
    const inventory = new Map<string, OffscreenPageInventoryEntry>()
    for (const [pageId, win] of this.ports.windowsByPageId) {
      if (win.isDestroyed()) {
        continue
      }
      inventory.set(pageId, {
        webContentsId: win.webContents.id,
        url: win.webContents.getURL?.() ?? '',
        lastActivityAt: this.lastActivityByPageId.get(pageId) ?? 0,
        hasActiveLease: this.browserManager.isPaintLeaseHeld(win.webContents.id)
      })
    }
    return inventory
  }

  async sleepPage(browserPageId: string): Promise<void> {
    const win = this.ports.windowsByPageId.get(browserPageId)
    if (!win || win.isDestroyed() || this.sleepingByPageId.has(browserPageId)) {
      return
    }
    const wc = win.webContents
    let url = ''
    try {
      // Why navigationHistory over getURL(): keeps the tab's back stack across the sleep.
      const entries = wc.navigationHistory?.getAllEntries?.() ?? []
      if (entries.length > 0) {
        const activeIndex = wc.navigationHistory.getActiveIndex()
        url = entries[activeIndex]?.url ?? entries[0]?.url ?? ''
        this.sleepingHistoryByPageId.set(browserPageId, { entries, activeIndex })
      }
    } catch {
      // getURL fallback below
    }
    if (!url) {
      url = wc.getURL?.() ?? ''
    }
    const registrationWorktreeId = this.browserManager.getWorktreeIdForTab(browserPageId)
    const profileId = this.browserManager.getSessionProfileIdForTab(browserPageId) ?? undefined
    this.sleepingByPageId.set(browserPageId, {
      url: url || 'about:blank',
      ...(registrationWorktreeId !== undefined ? { worktreeId: registrationWorktreeId } : {}),
      ...(profileId ? { profileId } : {}),
      sleptAt: Date.now()
    })
    // Close without consuming the sleeping record: a window death mid-sleep must not
    // drop the restore params, but the guest registration has to go with the window.
    this.ports.windowsByPageId.delete(browserPageId)
    this.lastActivityByPageId.delete(browserPageId)
    this.browserManager.unregisterGuest(browserPageId)
    try {
      await this.ports.retirePageOwner(browserPageId)
    } finally {
      win.destroy()
    }
  }

  /** Recreates a sleeping page's window in place; returns false when the id was not sleeping. */
  async wakePage(browserPageId: string): Promise<boolean> {
    const sleeping = this.sleepingByPageId.get(browserPageId)
    if (!sleeping) {
      return false
    }
    if (this.ports.isShuttingDown()) {
      throw new Error('Offscreen browser backend is shutting down')
    }
    await this.ports.createTab({
      browserPageId,
      url: sleeping.url,
      worktreeId: sleeping.worktreeId,
      profileId: sleeping.profileId
    })
    const win = this.ports.windowsByPageId.get(browserPageId)
    if (!win || win.isDestroyed()) {
      return true
    }
    try {
      const sourceEntries = this.sleepingHistoryByPageId.get(browserPageId)
      if (sourceEntries && sourceEntries.entries.length > 0) {
        await win.webContents.navigationHistory.restore({
          entries: sourceEntries.entries,
          index: sourceEntries.activeIndex
        })
      }
    } catch {
      // createTab already loaded lastUrl; restore is best-effort.
    }
    this.sleepingHistoryByPageId.delete(browserPageId)
    return true
  }
}
