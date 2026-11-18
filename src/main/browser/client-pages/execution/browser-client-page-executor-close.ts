import type { BrowserClientPageCommandExecutorDependencies } from './browser-client-page-command-executor-dependencies'
import type { BrowserClientPageRendererIdentity } from '../../../../shared/browser/client-hosting/browser-client-page-renderer-protocol'
import { cleanupRetainedBrowserClientPage } from '../lifecycle/browser-client-page-cleanup'
import type { BrowserClientRetainedPage } from '../lifecycle/browser-client-page-retained-state'
import type { BrowserClientUploadStaging } from '../../client-hosts/file-transfers/browser-client-upload-staging'
import { forgetBrowserClientRetainedPage } from '../lifecycle/browser-client-page-retained-state'
import type { BrowserClientProfileSwitches } from '../lifecycle/browser-client-page-profile-switch'

export async function closeBrowserClientExecutorPages(input: {
  profileSwitches: Pick<BrowserClientProfileSwitches, 'retainedCleanups' | 'stagedPages'>
  creatingPages: ReadonlyMap<string, unknown>
  failedPages: ReadonlyMap<string, unknown>
  pages: Map<string, BrowserClientRetainedPage>
  cleanupPage(page: BrowserClientRetainedPage): Promise<void>
  uploadStaging?: BrowserClientUploadStaging
}): Promise<void> {
  const retired = await Promise.allSettled(
    [...input.profileSwitches.retainedCleanups].map(async (cleanup) => {
      await cleanup()
      input.profileSwitches.retainedCleanups.delete(cleanup)
    })
  )
  const failures: unknown[] = [
    ...retired.filter((result) => result.status === 'rejected').map((result) => result.reason),
    ...(input.creatingPages.size > 0 || input.profileSwitches.stagedPages.size > 0
      ? [new Error('browser_client_page_creation_still_running')]
      : []),
    ...(input.failedPages.size > 0 ? [new Error('browser_client_page_cleanup_unresolved')] : [])
  ]
  for (const [browserPageId, page] of input.pages) {
    try {
      page.retiring = input.cleanupPage(page)
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

export async function cleanupBrowserClientExecutorPage(
  dependencies: BrowserClientPageCommandExecutorDependencies,
  page: BrowserClientRetainedPage,
  previousRendererPage?: Readonly<BrowserClientPageRendererIdentity>,
  releaseUploads = true
): Promise<void> {
  if (!page.cleanup) {
    page.releaseAvailabilityWatch?.()
    page.releaseAvailabilityWatch = undefined
    dependencies.guestBinding.release(page.registration)
  }
  return cleanupRetainedBrowserClientPage(
    page,
    {
      routeWebContents: dependencies.routeWebContents,
      retireAutomation: dependencies.retireAutomation,
      releaseUploadStaging: async () => {
        if (releaseUploads) {
          await dependencies.uploadStaging?.releasePage(page.inventory.browserPageId)
        }
      }
    },
    previousRendererPage
  )
}

export async function closeBrowserClientExecutor(
  input: Parameters<typeof closeBrowserClientExecutorPages>[0] & {
    closeInitializations(): Promise<void>
  }
): Promise<void> {
  const failures: unknown[] = []
  await input.closeInitializations().catch((error: unknown) => failures.push(error))
  await closeBrowserClientExecutorPages(input).catch((error: unknown) => failures.push(error))
  if (failures.length) {
    throw new AggregateError(failures, 'Browser client page executor cleanup failed')
  }
}
