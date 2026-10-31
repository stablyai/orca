import {
  sameRuntimeBrowserPlacement,
  type RuntimeBrowserClientPlacement
} from '../../shared/runtime-browser-placement'
import { getRuntimeBrowserPageRegistry } from './runtime-browser-page-registry'

export type RuntimeBrowserClientPageReleaseHost = {
  notifyMobileSessionTabsChanged?(workspaceId: string): void
  retireRuntimeOwnedBrowserSessionTab?(workspaceId: string, browserPageId: string): void
}

/** Retire on workspace removal or unrecoverable placement loss; lease fences retain via retainRuntimeBrowserClientPageRecord. Newer placements survive stale release. */
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

/** Retain dead placement identity for same-host recovery while releasing routing/capacity; browserTabClose can retire without the absent host.
 * Retained rows occupy the 256-page registry indefinitely: only close, workspace removal or failed recovery frees them; no TTL/reaper exists. */
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
  // Republish undrivable retained pages to clear transient loading state.
  pages.updatePage(browserPageId, page.placement, { loading: false })
  runtime.notifyMobileSessionTabsChanged?.(page.workspaceId)
  return true
}
