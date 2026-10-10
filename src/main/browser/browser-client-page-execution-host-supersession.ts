import type { BrowserClientPageNetworkRoute } from './browser-client-page-cleanup'
import type { BrowserClientRetainedPage } from './browser-client-page-retained-state'

type SupersedingRoute = Pick<BrowserClientPageNetworkRoute, 'key' | 'executionHostIdentity'>

/**
 * Retires the pages left on a superseded generation of one execution host.
 *
 * An execution host's storage identity outlives its per-connection route key (an SSH reconnect or
 * a runtime restart mints a new key against the same storage), so both generations resolve to the
 * same Chromium partition -- which carries a single proxy endpoint. The older pages therefore have
 * to go before the newer route can bind that partition, and they are already unreachable: the
 * rotation that minted the new key fenced their tunnel.
 *
 * Callers must pass a route that has already started, which proves it is the current generation
 * and not a late command carrying a stale key.
 */
export async function retireSupersededExecutionHostPages(
  pages: Iterable<BrowserClientRetainedPage>,
  route: SupersedingRoute,
  retirePage: (browserPageId: string, pageHostGeneration: number) => Promise<boolean>
): Promise<void> {
  const failures: unknown[] = []
  // Retirement mutates the caller's page index, so decide the set before touching any of it.
  const retained = Array.from(pages)
  for (const page of retained) {
    if (
      page.route.executionHostIdentity !== route.executionHostIdentity ||
      page.route.key === route.key
    ) {
      continue
    }
    try {
      await retirePage(page.inventory.browserPageId, page.generation)
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Browser client page execution host supersession failed')
  }
}
