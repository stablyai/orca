import { getBrowserHostLeaseRegistry } from './browser-host-lease-registry-instance'
import { closeRuntimeBrowserClientPage } from './runtime-browser-client-page-creation'
import {
  releaseRuntimeBrowserClientPageRecord,
  type RuntimeBrowserClientPageReleaseHost
} from './runtime-browser-client-page-release'
import { getRuntimeBrowserPageRegistry } from './runtime-browser-page-registry'

export type WorktreeBrowserClientPageCloseHost = {
  getRuntimeId(): string
} & RuntimeBrowserClientPageReleaseHost

/**
 * Tears down the client-hosted browser pages a removed worktree owned.
 *
 * The lease command is the only way to reach the client's retained webview: the host protocol
 * carries no worktree, so a client cannot scope this itself. The runtime record is dropped whether
 * or not the client acknowledges — worktree IDs are path-derived and can be recreated, so a
 * surviving record would republish the dead worktree's tabs and let reconnect recovery
 * re-materialize a webview for a page nobody can reach any more.
 */
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
