import { BrowserError } from '../../browser/browser-error'
import { closeRuntimeBrowserClientPage } from '../runtime-browser-client-page-creation'
import type { RuntimeBrowserClientPage } from '../runtime-browser-page-registry'
import type { RuntimeBrowserCommandHost } from './browser-command-contracts'

// Why no Electron import: a Node host with no browser engine closes these pages too.
export type BrowserClientPageCloseHost = Pick<
  RuntimeBrowserCommandHost,
  | 'getRuntimeBrowserPageRegistry'
  | 'getBrowserHostLeaseRegistry'
  | 'retireRuntimeOwnedBrowserSessionTab'
  | 'notifyHeadlessBrowserSessionTabsChanged'
  | 'resolveBrowserWorkspace'
>

type PageCloseParams = { page?: string; worktree?: string }

export async function retireRuntimeBrowserClientPage(
  host: BrowserClientPageCloseHost,
  clientPage: RuntimeBrowserClientPage
): Promise<{ closed: true }> {
  const authority = host.getBrowserHostLeaseRegistry()
  // Why: a retained page whose host quit has no placement left to command, and asking the
  // absent host first would refuse the close and strand the tab with no way to dismiss it.
  if (authority.getPlacement(clientPage.browserPageId)) {
    await closeRuntimeBrowserClientPage(authority, {
      browserPageId: clientPage.browserPageId,
      placement: clientPage.placement
    })
  }
  if (
    !host.getRuntimeBrowserPageRegistry().retirePage(clientPage.browserPageId, clientPage.placement)
  ) {
    throw new Error('browser_page_placement_stale')
  }
  if (host.retireRuntimeOwnedBrowserSessionTab) {
    host.retireRuntimeOwnedBrowserSessionTab(clientPage.workspaceId, clientPage.browserPageId)
  } else {
    host.notifyHeadlessBrowserSessionTabsChanged?.(clientPage.workspaceId)
  }
  return { closed: true }
}

/** Closes a named page this runtime's registry holds; null when the registry has no such page. */
export async function closeRegisteredBrowserClientPage(
  host: BrowserClientPageCloseHost,
  params: PageCloseParams
): Promise<{ closed: true } | null> {
  const clientPage = params.page
    ? host.getRuntimeBrowserPageRegistry().getPage(params.page)
    : undefined
  if (!clientPage) {
    return null
  }
  if (
    params.worktree &&
    (await host.resolveBrowserWorkspace(params.worktree)).id !== clientPage.workspaceId
  ) {
    throw new BrowserError(
      'browser_tab_not_found',
      `Browser page ${clientPage.browserPageId} was not found in this worktree`
    )
  }
  return retireRuntimeBrowserClientPage(host, clientPage)
}

/**
 * Page-targeted close on a host with no browser engine. Client-hosted pages and session rows
 * are runtime records, so retiring them never needed the engine; anything else still refuses.
 */
export async function closeBrowserPageWithoutEngine(
  host: BrowserClientPageCloseHost,
  params: PageCloseParams,
  unavailable: () => BrowserError
): Promise<{ closed: true }> {
  const closed = await closeRegisteredBrowserClientPage(host, params)
  if (closed) {
    return closed
  }
  if (
    params.page &&
    params.worktree &&
    host.retireRuntimeOwnedBrowserSessionTab?.(
      (await host.resolveBrowserWorkspace(params.worktree)).id,
      params.page
    ) === true
  ) {
    return { closed: true }
  }
  throw unavailable()
}
