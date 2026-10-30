import {
  browserRouteLogicalPageKey,
  isValidBrowserRoutePageOwnerIdentity,
  type BrowserRoutePageAuthority,
  type BrowserRoutePageOwnerIdentity
} from './browser-route-page-authority'

export class BrowserRoutePreparedPageLedger {
  private readonly active = new Map<string, BrowserRoutePageAuthority>()
  private readonly retiring = new Map<string, symbol>()

  constructor(
    private readonly partition: string,
    private readonly maxPages: number
  ) {}

  hasActivePages(): boolean {
    return this.active.size > 0
  }

  isIdle(): boolean {
    return this.active.size === 0 && this.retiring.size === 0
  }

  getAuthority(input: BrowserRoutePageOwnerIdentity): symbol | null {
    if (!isValidBrowserRoutePageOwnerIdentity(input) || input.partition !== this.partition) {
      return null
    }
    const page = this.active.get(pageKey(input))
    return page?.rendererWebContentsId === input.rendererWebContentsId ? page.pageAuthority : null
  }

  link(
    browserPageId: string,
    pageHostGeneration: number,
    rendererWebContentsId: number
  ): BrowserRoutePageAuthority {
    const key = browserRouteLogicalPageKey(browserPageId, pageHostGeneration)
    if (this.retiring.has(key)) {
      throw new Error('browser_route_partition_page_retiring')
    }
    if (!this.active.has(key) && this.active.size + this.retiring.size >= this.maxPages) {
      throw new Error('browser_route_partition_page_capacity')
    }
    const existing = this.active.get(key)
    if (existing && existing.rendererWebContentsId !== rendererWebContentsId) {
      throw new Error('browser_route_partition_page_owner_conflict')
    }
    const page = {
      partition: this.partition,
      browserPageId,
      pageHostGeneration,
      rendererWebContentsId,
      pageAuthority: Symbol(key)
    }
    this.active.set(key, page)
    return page
  }

  rekey(
    previous: BrowserRoutePageAuthority,
    next: BrowserRoutePageOwnerIdentity
  ): BrowserRoutePageAuthority | null {
    if (
      !this.isExactActivePage(previous) ||
      !isValidBrowserRoutePageOwnerIdentity(next) ||
      next.partition !== this.partition ||
      next.browserPageId !== previous.browserPageId ||
      next.rendererWebContentsId !== previous.rendererWebContentsId ||
      next.pageHostGeneration === previous.pageHostGeneration
    ) {
      return null
    }
    const previousKey = pageKey(previous)
    const nextKey = pageKey(next)
    if (this.active.has(nextKey) || this.retiring.has(nextKey)) {
      return null
    }
    const rekeyed = { ...next, pageAuthority: previous.pageAuthority }
    this.active.delete(previousKey)
    this.active.set(nextKey, rekeyed)
    return rekeyed
  }

  beginRetirement(page: BrowserRoutePageAuthority): boolean {
    if (!this.isExactActivePage(page)) {
      return false
    }
    const key = pageKey(page)
    this.active.delete(key)
    this.retiring.set(key, page.pageAuthority)
    return true
  }

  beginRendererRetirements(rendererWebContentsId: number): BrowserRoutePageAuthority[] {
    if (!Number.isInteger(rendererWebContentsId) || rendererWebContentsId <= 0) {
      return []
    }
    const owned = [...this.active.values()].filter(
      (page) => page.rendererWebContentsId === rendererWebContentsId
    )
    return owned.filter((page) => this.beginRetirement(page))
  }

  completeRetirement(page: BrowserRoutePageAuthority): void {
    const key = pageKey(page)
    if (this.retiring.get(key) === page.pageAuthority) {
      this.retiring.delete(key)
    }
  }

  private isExactActivePage(page: BrowserRoutePageAuthority): boolean {
    if (
      !isValidBrowserRoutePageOwnerIdentity(page) ||
      typeof page.pageAuthority !== 'symbol' ||
      page.partition !== this.partition
    ) {
      return false
    }
    const active = this.active.get(pageKey(page))
    return (
      active?.pageAuthority === page.pageAuthority &&
      active.rendererWebContentsId === page.rendererWebContentsId
    )
  }
}

export function assertBrowserRoutePreparedPageOwner(
  browserPageId: string,
  pageHostGeneration: number,
  rendererWebContentsId: number
): void {
  if (
    !isValidBrowserRoutePageOwnerIdentity({
      partition: 'route',
      browserPageId,
      pageHostGeneration,
      rendererWebContentsId
    })
  ) {
    throw new Error('browser_route_partition_page_invalid')
  }
}

function pageKey(
  page: Pick<BrowserRoutePageOwnerIdentity, 'browserPageId' | 'pageHostGeneration'>
) {
  return browserRouteLogicalPageKey(page.browserPageId, page.pageHostGeneration)
}
