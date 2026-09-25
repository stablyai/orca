import {
  sameRuntimeBrowserPlacement,
  type RuntimeBrowserClientPlacement
} from '../../shared/runtime-browser-placement'
import { getRuntimeBrowserPageRegistry } from './runtime-browser-page-registry'

export type RuntimeBrowserClientPageReleaseHost = {
  notifyMobileSessionTabsChanged?(workspaceId: string): void
  retireRuntimeOwnedBrowserSessionTab?(workspaceId: string, browserPageId: string): void
}

/**
 * Drops the runtime's record of a client page no host can serve any more.
 *
 * Reached by the deliberately destructive paths -- worktree removal, and recovery that could not
 * re-place a page at all. A lease fence retains instead, see
 * {@link retainRuntimeBrowserClientPageRecord}.
 * A page already re-placed under another lease keeps its record: the placement no longer matches.
 */
export function releaseRuntimeBrowserClientPageRecord(
  runtime: RuntimeBrowserClientPageReleaseHost,
  browserPageId: string,
  placement: RuntimeBrowserClientPlacement
): boolean {
  const pages = getRuntimeBrowserPageRegistry(runtime)
  const page = pages.getPage(browserPageId)
  if (!page || !pages.retirePage(browserPageId, placement)) {
    return false
  }
  if (runtime.retireRuntimeOwnedBrowserSessionTab) {
    runtime.retireRuntimeOwnedBrowserSessionTab(page.workspaceId, browserPageId)
  } else {
    runtime.notifyMobileSessionTabsChanged?.(page.workspaceId)
  }
  return true
}

/**
 * Keeps a client page whose host went away, so its tab survives the desktop that placed it.
 *
 * A quit desktop used to take its pages down with it: the lease fenced and every tab it placed
 * vanished for every client. Terminals outlive a client quit, and browser tabs have to as well.
 * The record keeps its now-dead placement, which is what a returning host of the same identity
 * matches on to recover the page; the placement registry entry is still released, so command
 * routing and its own capacity are not pinned by a host that may never return.
 *
 * What retention does pin is the page registry: a retained record holds one of the runtime's 256
 * pages (DEFAULT_MAX_RUNTIME_BROWSER_PAGES) for the runtime's life. There is no TTL and no reaper —
 * only a user close, a worktree removal, or recovery giving up on the page frees it. That is bounded
 * by tabs the user never closed, because a returning host re-places its pages rather than adding to
 * them, but it is not bounded by anything the runtime does on its own.
 *
 * Retained tabs stay closeable: `browserTabClose` retires a page whose placement is gone without
 * asking the absent host first.
 */
export function retainRuntimeBrowserClientPageRecord(
  runtime: RuntimeBrowserClientPageReleaseHost,
  browserPageId: string,
  placement: RuntimeBrowserClientPlacement
): boolean {
  const pages = getRuntimeBrowserPageRegistry(runtime)
  const page = pages.getPage(browserPageId)
  if (!page || !sameRuntimeBrowserPlacement(page.placement, placement)) {
    return false
  }
  // Why: the page is still listed but nothing can drive it, so republish to settle transient state.
  pages.updatePage(browserPageId, page.placement, { loading: false })
  runtime.notifyMobileSessionTabsChanged?.(page.workspaceId)
  return true
}
