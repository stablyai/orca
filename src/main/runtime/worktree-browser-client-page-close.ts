import { getBrowserHostLeaseRegistry } from './browser-host/browser-host-lease-registry-instance'
import { closeRuntimeBrowserClientPage } from './runtime-browser-client-page-creation'
import {
  releaseRuntimeBrowserClientPageRecord,
  type RuntimeBrowserClientPageReleaseHost
} from './runtime-browser-client-page-release'
import { getRuntimeBrowserPageRegistry } from './runtime-browser-page-registry'

export type WorktreeBrowserClientPageCloseHost = {
  getRuntimeId(): string
} & RuntimeBrowserClientPageReleaseHost

/** Only the lease command reaches retained client webviews; host messages lack workspace scope. Drop runtime records even without acknowledgement so path-id reuse cannot republish dead tabs or recreate unreachable pages. */
export function closeClientHostedBrowserPagesForWorktree(
  runtime: WorktreeBrowserClientPageCloseHost,
  worktreeId: string
): void {
  const openPages = getRuntimeBrowserPageRegistry(runtime).listPages(worktreeId)
  if (openPages.length === 0) {
    return
  }
  const authority = getBrowserHostLeaseRegistry(runtime)
  for (const page of openPages) {
    void closeRuntimeBrowserClientPage(authority, {
      browserPageId: page.browserPageId,
      placement: page.placement
    }).catch((error) => {
      console.warn('[browser-host-lease] removed worktree could not close its client page:', {
        browserPageId: page.browserPageId,
        worktreeId,
        error
      })
    })
    releaseRuntimeBrowserClientPageRecord(runtime, page.browserPageId, page.placement)
  }
}
