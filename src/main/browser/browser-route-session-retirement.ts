import type { BrowserRoutePageAuthority } from './browser-route-page-authority'
import type { PreparedBrowserRoutePartition } from './browser-route-session-state'

export function retireBrowserRouteSessionPage(
  live: ReadonlyMap<string, PreparedBrowserRoutePartition>,
  input: BrowserRoutePageAuthority,
  settle: (state: PreparedBrowserRoutePartition, page: BrowserRoutePageAuthority) => void
): boolean {
  const state = live.get(input.partition)
  if (!state || !state.pages.beginRetirement(input)) {
    return false
  }
  settle(state, input)
  return true
}
