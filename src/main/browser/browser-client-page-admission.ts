import { BrowserClientPageCommandError } from './browser-client-page-command-failure'

/** Admission for a createPage command: the id must be fresh across every tracking map and capacity must remain. */
export function assertBrowserClientPageAdmission(
  trackedPages: readonly ReadonlyMap<string, unknown>[],
  maxPages: number,
  browserPageId: string
): void {
  if (trackedPages.some((tracked) => tracked.has(browserPageId))) {
    throw new BrowserClientPageCommandError('browser_client_page_generation_conflict')
  }
  const trackedCount = trackedPages.reduce((total, tracked) => total + tracked.size, 0)
  if (trackedCount >= maxPages) {
    throw new BrowserClientPageCommandError('browser_client_page_capacity')
  }
}
