import type { BrowserClientRetainedPage } from './browser-client-page-retained-state'
import type { BrowserClientUploadStaging } from './browser-client-upload-staging'
import { forgetBrowserClientRetainedPage } from './browser-client-page-retained-state'
import type { BrowserClientProfileSwitches } from './browser-client-page-profile-switch'

export async function closeBrowserClientExecutorPages(input: {
  profileSwitches: Pick<BrowserClientProfileSwitches, 'retainedCleanups' | 'stagedPages'>
  creatingPages: ReadonlyMap<string, unknown>
  failedPages: ReadonlyMap<string, unknown>
  pages: Map<string, BrowserClientRetainedPage>
  cleanupPage(page: BrowserClientRetainedPage): Promise<void>
  uploadStaging?: BrowserClientUploadStaging
}): Promise<void> {
  const retired = await Promise.allSettled(input.profileSwitches.retainedCleanups)
  const failures: unknown[] = [
    ...retired.filter((result) => result.status === 'rejected').map((result) => result.reason),
    ...(input.creatingPages.size > 0 || input.profileSwitches.stagedPages.size > 0
      ? [new Error('browser_client_page_creation_still_running')]
      : []),
    ...(input.failedPages.size > 0 ? [new Error('browser_client_page_cleanup_unresolved')] : [])
  ]
  for (const [browserPageId, page] of input.pages) {
    try {
      page.retiring ??= input.cleanupPage(page)
      await page.retiring
      forgetBrowserClientRetainedPage(input.pages, browserPageId, page)
    } catch (error) {
      failures.push(error)
    }
  }
  await input.uploadStaging?.releaseAll().catch((error: unknown) => {
    failures.push(error)
  })
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Browser client page executor cleanup failed')
  }
}
