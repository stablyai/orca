import type { RuntimeBrowserTabQueries } from './browser-tab-queries'
import {
  resolveClientPageToClose,
  retireRuntimeBrowserClientPage
} from './browser-client-page-close'
import { BrowserError } from '../../browser/browser-error'
import { browserManager } from '../../browser/browser-manager'
import { closeBrowserTabInRenderer } from './browser-tab-renderer-close'
import type { RuntimeBrowserCommandHost } from './browser-command-contracts'
import type { RuntimeBrowserCommandTargets } from './browser-command-targets'

export class RuntimeBrowserTabClose {
  constructor(
    private readonly queries: Pick<
      RuntimeBrowserTabQueries,
      'browserTabList' | 'browserTabCurrent'
    >,
    private readonly host: Pick<
      RuntimeBrowserCommandHost,
      | 'getRuntimeBrowserPageRegistry'
      | 'resolveBrowserWorkspace'
      | 'getBrowserHostLeaseRegistry'
      | 'retireRuntimeOwnedBrowserSessionTab'
      | 'notifyHeadlessBrowserSessionTabsChanged'
      | 'getAgentBrowserBridge'
      | 'resolveWorkspaceSelector'
      | 'getAvailableAuthoritativeWindow'
      | 'getOffscreenBrowserBackend'
      | 'getAuthoritativeWindow'
    >,
    private readonly targets: Pick<
      RuntimeBrowserCommandTargets,
      'resolveBrowserWorktreeId' | 'retireGhostBrowserSessionRow'
    >
  ) {}

  async browserTabClose(params: {
    index?: number
    page?: string
    worktree?: string
  }): Promise<{ closed: boolean }> {
    const clientPage = await resolveClientPageToClose(this.host, this.queries, params)
    if (clientPage) {
      return retireRuntimeBrowserClientPage(this.host, clientPage)
    }
    const namedPageId =
      typeof params.page === 'string' && params.page.length > 0 ? params.page : null
    const explicitPage = namedPageId !== null
    const bridge = this.host.getAgentBrowserBridge()
    if (!bridge) {
      // Even without a live browser session, a retained row may still need retirement.
      if (
        namedPageId &&
        params.worktree &&
        this.targets.retireGhostBrowserSessionRow(
          (await this.host.resolveWorkspaceSelector(params.worktree)).id,
          namedPageId
        )
      ) {
        return { closed: true }
      }
      throw new BrowserError('browser_no_tab', 'No browser session is active')
    }
    const worktreeId = explicitPage
      ? params.worktree
        ? (await this.host.resolveWorkspaceSelector(params.worktree)).id
        : undefined
      : await this.targets.resolveBrowserWorktreeId(params.worktree)

    let tabId: string | null = null
    if (namedPageId !== null) {
      tabId = namedPageId
    } else if (params.index !== undefined) {
      const tabs = bridge.getRegisteredTabs(worktreeId)
      const entries = [...tabs.entries()]
      if (params.index < 0 || params.index >= entries.length) {
        throw new Error(`Tab index ${params.index} out of range (0-${entries.length - 1})`)
      }
      tabId = entries[params.index][0]
    } else {
      // Unmounted tabs need renderer fallback when the bridge has not registered them.
      const tabs = bridge.getRegisteredTabs(worktreeId)
      const entries = [...tabs.entries()]
      const activeEntry = entries.find(([, wcId]) => wcId === bridge.getActiveWebContentsId())
      if (activeEntry) {
        tabId = activeEntry[0]
      }
    }

    // Popups are windows, not renderer tabs; close them as the page's own window.close() would.
    if (
      tabId &&
      bridge.getRegisteredTabs(worktreeId).has(tabId) &&
      browserManager.closePopupPage(tabId)
    ) {
      return { closed: true }
    }

    const authoritativeWindow = this.host.getAvailableAuthoritativeWindow()
    const offscreen = authoritativeWindow ? null : this.host.getOffscreenBrowserBackend()
    if (offscreen) {
      // An implicit close needs a real active page or would falsely report success.
      const resolvedTabId = tabId ?? bridge.getActivePageId(worktreeId)
      if (!resolvedTabId) {
        return { closed: false }
      }
      if (explicitPage && !bridge.getRegisteredTabs(worktreeId).has(resolvedTabId)) {
        if (this.targets.retireGhostBrowserSessionRow(worktreeId, resolvedTabId)) {
          return { closed: true }
        }
        const scope = worktreeId ? ' in this worktree' : ''
        throw new BrowserError(
          'browser_tab_not_found',
          `Browser page ${resolvedTabId} was not found${scope}`
        )
      }
      await offscreen.closeTab(resolvedTabId)
      // Destroying the guest alone leaves paired clients' session rows stale.
      if (worktreeId) {
        if (this.host.retireRuntimeOwnedBrowserSessionTab) {
          this.host.retireRuntimeOwnedBrowserSessionTab(worktreeId, resolvedTabId)
        } else {
          this.host.notifyHeadlessBrowserSessionTabsChanged?.(worktreeId)
        }
      }
      return { closed: true }
    }

    if (!authoritativeWindow && tabId && !bridge.getRegisteredTabs(worktreeId).has(tabId)) {
      if (this.targets.retireGhostBrowserSessionRow(worktreeId, tabId)) {
        return { closed: true }
      }
      const scope = worktreeId ? ' in this worktree' : ''
      throw new BrowserError('browser_tab_not_found', `Browser page ${tabId} was not found${scope}`)
    }

    const win = authoritativeWindow ?? this.host.getAuthoritativeWindow()
    await closeBrowserTabInRenderer(win, tabId, worktreeId)

    return { closed: true }
  }
}
