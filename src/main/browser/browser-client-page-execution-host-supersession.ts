import type { BrowserClientPageNetworkRoute } from './browser-client-page-cleanup'
import type { BrowserClientRetainedPage } from './browser-client-page-retained-state'

type SupersedingRoute = Pick<BrowserClientPageNetworkRoute, 'key' | 'executionHostIdentity'>

/** Pass a started route: older generations share its partition’s single proxy endpoint. */
export async function retireSupersededExecutionHostPages(
  pages: Iterable<BrowserClientRetainedPage>,
  route: SupersedingRoute,
  retirePage: (browserPageId: string, pageHostGeneration: number) => Promise<boolean>
): Promise<void> {
  const failures: unknown[] = []
  // Snapshot because retiring pages mutates the source index.
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
