import type { BrowserRoutePageAuthority } from './browser-route-page-authority'
import type { BrowserRouteRendererPrepareFenceRegistry } from './browser-route-renderer-prepare-fence'
import type { PreparedBrowserRoutePartition } from './browser-route-session-state'

export function retireBrowserRouteSessionRendererPages(input: {
  rendererWebContentsId: number
  rendererPrepareFences: BrowserRouteRendererPrepareFenceRegistry
  live: ReadonlyMap<string, PreparedBrowserRoutePartition>
  settle: (state: PreparedBrowserRoutePartition, page: BrowserRoutePageAuthority) => void
}): number {
  if (!Number.isInteger(input.rendererWebContentsId) || input.rendererWebContentsId <= 0) {
    return 0
  }
  input.rendererPrepareFences.retire(input.rendererWebContentsId)
  const retirements = [...input.live.values()].map((state) => ({
    state,
    pages: state.pages.beginRendererRetirements(input.rendererWebContentsId)
  }))
  let retiredCount = 0
  for (const { state, pages } of retirements) {
    retiredCount += pages.length
    for (const page of pages) {
      input.settle(state, page)
    }
  }
  return retiredCount
}
