import { BrowserError } from '../../browser/browser-error'
import { closeRuntimeBrowserClientPage } from '../runtime-browser-client-page-creation'
import type { RuntimeBrowserClientPage } from '../runtime-browser-page-registry'
import type { RuntimeBrowserCommandHost } from './browser-command-contracts'

// Engine-free Node hosts also close client-hosted pages.
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
  // Retained tabs outlive placements; requiring an absent host would make them impossible to dismiss.
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

/** Resolve index/current against the complete logical list so client pages cannot be mistaken for engine tabs. */
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

/** Runtime records can retire without an engine; refuse targets outside those records. */
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
