import type {
  BrowserRoutePageAuthority,
  BrowserRoutePageOwnerIdentity
} from './browser-route-page-authority'
import type {
  BrowserRouteSessionRekey,
  PreparedBrowserRoutePartition
} from './browser-route-session-state'

export function getBrowserRoutePreparedPageAuthority(
  live: ReadonlyMap<string, PreparedBrowserRoutePartition>,
  input: BrowserRoutePageOwnerIdentity
): symbol | null {
  return live.get(input.partition)?.pages.getAuthority(input) ?? null
}

export function rekeyBrowserRouteSessionPage(
  live: ReadonlyMap<string, PreparedBrowserRoutePartition>,
  previous: BrowserRoutePageAuthority,
  next: BrowserRoutePageOwnerIdentity,
  retirePreparedPage: (page: BrowserRoutePageAuthority) => boolean
): BrowserRouteSessionRekey | null {
  const state = live.get(previous.partition)
  if (!state || next.partition !== previous.partition) {
    return null
  }
  const page = state.pages.rekey(previous, next)
  if (!page) {
    return null
  }
  return {
    page,
    routeSession: {
      partition: state.partition,
      release: () => void retirePreparedPage(page)
    }
  }
}
