import type { BrowserWindow } from 'electron'
import type { BrowserLoadError } from '../../shared/browser-workspace-types'
import type { ParkedBrowserPage } from './browser-backend'

// Why (STA-4341): a headless browser page and the renderer behind it have
// different lifetimes — the page is open until it is closed, the renderer only
// while something needs it. This is the book of open pages; the backend owns
// the renderers. Keeping them apart is what makes "parked" expressible: a
// record here with no window attached.

export type OffscreenBrowserPage = {
  browserPageId: string
  worktreeId?: string
  profileId?: string
  partition: string
  url: string
  title: string
  /** null while parked — the page exists, its renderer does not. */
  window: BrowserWindow | null
  /** Whether the page was its worktree's active tab when it parked. */
  activeWhenParked: boolean
  /** True while the initial or post-wake navigation is still in flight. */
  loading: boolean
  /** The failure the page reported when its renderer was reclaimed. */
  loadError: BrowserLoadError | null
  lastActivityAt: number
}

function isResident(page: OffscreenBrowserPage): boolean {
  return Boolean(page.window && !page.window.isDestroyed())
}

export class OffscreenBrowserOpenPages {
  private readonly pages = new Map<string, OffscreenBrowserPage>()

  get size(): number {
    return this.pages.size
  }

  has(browserPageId: string): boolean {
    return this.pages.has(browserPageId)
  }

  get(browserPageId: string): OffscreenBrowserPage | undefined {
    return this.pages.get(browserPageId)
  }

  add(page: OffscreenBrowserPage): void {
    this.pages.set(page.browserPageId, page)
  }

  delete(browserPageId: string): OffscreenBrowserPage | undefined {
    const page = this.pages.get(browserPageId)
    this.pages.delete(browserPageId)
    return page
  }

  clear(): void {
    this.pages.clear()
  }

  all(): OffscreenBrowserPage[] {
    return [...this.pages.values()]
  }

  resident(): OffscreenBrowserPage[] {
    return this.all().filter(isResident)
  }

  parked(worktreeId?: string): OffscreenBrowserPage[] {
    return this.all().filter(
      (page) => !isResident(page) && (!worktreeId || page.worktreeId === worktreeId)
    )
  }

  /**
   * Every open page's id in creation order, resident or parked. Listings order
   * by this so a tab's position never moves because its renderer was reclaimed
   * — an index read minutes ago must not be renumbered by a background timer.
   */
  openIds(worktreeId?: string): string[] {
    return this.all()
      .filter((page) => !worktreeId || page.worktreeId === worktreeId)
      .map((page) => page.browserPageId)
  }

  listParked(worktreeId?: string): ParkedBrowserPage[] {
    return this.parked(worktreeId).map((page) => ({
      browserPageId: page.browserPageId,
      worktreeId: page.worktreeId,
      profileId: page.profileId,
      url: page.url,
      title: page.title,
      active: page.activeWhenParked,
      loadError: page.loadError
    }))
  }

  /**
   * The parked page a page-less command should target. Activity order alone is
   * wrong: an explicit `--page B` command makes B the most recently used while
   * A is still the active tab, and a page-less command has always meant "the
   * active tab". So the retained active page wins, and recency only breaks the
   * tie when none is recorded.
   */
  parkedIdForImplicitTarget(worktreeId?: string): string | null {
    // Why MRU among the flagged: the claim is strict per scope, so a scoped
    // query sees at most one flag — but the scope-less query spans every
    // worktree and can see one flag per scope. Recency picks the page that
    // actually held the most recent active claim, matching the bridge's own
    // global-pointer semantics; creation order would pick the oldest scope.
    let flagged: OffscreenBrowserPage | null = null
    let best: OffscreenBrowserPage | null = null
    for (const page of this.parked(worktreeId)) {
      if (page.activeWhenParked && (!flagged || page.lastActivityAt > flagged.lastActivityAt)) {
        flagged = page
      }
      if (!best || page.lastActivityAt > best.lastActivityAt) {
        best = page
      }
    }
    return (flagged ?? best)?.browserPageId ?? null
  }

  /**
   * Only one page per worktree may carry the active flag across a park.
   * Strict scope: a worktree-less page clears only other worktree-less pages —
   * an undefined filter would wipe every worktree's flag host-wide.
   */
  claimParkedActive(browserPageId: string, worktreeId?: string): void {
    for (const page of this.parked()) {
      if (page.browserPageId !== browserPageId && page.worktreeId === worktreeId) {
        page.activeWhenParked = false
      }
    }
  }

  /**
   * Hand the active flag to the most recently used parked page when nothing
   * in the scope holds it. Closing the flag's holder (or the last live tab)
   * must not leave a worktree whose every page reports inactive — a paired
   * client assumes one selected browser tab per worktree.
   */
  promoteParkedActive(worktreeId?: string): void {
    const scoped = this.parked().filter((page) => page.worktreeId === worktreeId)
    if (scoped.length === 0 || scoped.some((page) => page.activeWhenParked)) {
      return
    }
    let best = scoped[0]
    for (const page of scoped) {
      if (page.lastActivityAt > best.lastActivityAt) {
        best = page
      }
    }
    best.activeWhenParked = true
  }
}
