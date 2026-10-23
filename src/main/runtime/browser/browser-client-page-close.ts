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

type LogicalTabQueries = {
  browserTabList(params: { worktree?: string }): Promise<{ tabs: { browserPageId: string }[] }>
  browserTabCurrent(params: { worktree?: string }): Promise<{ tab: { browserPageId: string } }>
}

/**
 * The client-hosted page a close names, by id, index or as the current tab; undefined when the
 * target is not one. Index and current resolve against the host's whole logical tab list, so a
 * client page that leads it is never mistaken for an engine tab.
 */
export async function resolveClientPageToClose(
  host: Pick<
    BrowserClientPageCloseHost,
    'getRuntimeBrowserPageRegistry' | 'resolveBrowserWorkspace'
  >,
  queries: LogicalTabQueries,
  params: PageCloseParams & { index?: number }
): Promise<RuntimeBrowserClientPage | undefined> {
  const pages = host.getRuntimeBrowserPageRegistry()
  if (params.page) {
    const page = pages.getPage(params.page)
    if (
      page &&
      params.worktree &&
      (await host.resolveBrowserWorkspace(params.worktree)).id !== page.workspaceId
    ) {
      throw new BrowserError(
        'browser_tab_not_found',
        `Browser page ${page.browserPageId} was not found in this worktree`
      )
    }
    return page
  }
  const workspaceId = params.worktree
    ? (await host.resolveBrowserWorkspace(params.worktree)).id
    : undefined
  if (pages.listPages(workspaceId).length === 0) {
    return undefined
  }
  const tab =
    params.index !== undefined
      ? (await queries.browserTabList({ worktree: params.worktree })).tabs[params.index]
      : (await queries.browserTabCurrent({ worktree: params.worktree })).tab
  return tab ? pages.getPage(tab.browserPageId) : undefined
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
