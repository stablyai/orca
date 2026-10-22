import type { RuntimeBrowserTabQueries } from './browser-tab-queries'
import {
  resolveClientPageToClose,
  retireRuntimeBrowserClientPage
} from './browser-client-page-close'
import { BrowserError } from '../../browser/browser-error'
import { randomUUID } from 'node:crypto'
import { ipcMain } from 'electron'
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
      | 'resolveWorktreeSelector'
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
      // Why before the refusal: a runtime with no browser session cannot be holding this page
      // either, but it can still be carrying the session row that names it.
      if (
        namedPageId &&
        params.worktree &&
        this.targets.retireGhostBrowserSessionRow(
          (await this.host.resolveWorktreeSelector(params.worktree)).id,
          namedPageId
        )
      ) {
        return { closed: true }
      }
      throw new BrowserError('browser_no_tab', 'No browser session is active')
    }
    const worktreeId = explicitPage
      ? params.worktree
        ? (await this.host.resolveWorktreeSelector(params.worktree)).id
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
      // Why: try the bridge first; fall back to the renderer for tabs whose webview hasn't mounted yet (e.g. just created).
      const tabs = bridge.getRegisteredTabs(worktreeId)
      const entries = [...tabs.entries()]
      const activeEntry = entries.find(([, wcId]) => wcId === bridge.getActiveWebContentsId())
      if (activeEntry) {
        tabId = activeEntry[0]
      }
    }

    // Why: headless serve has no renderer to ask, so destroy the offscreen page directly.
    const authoritativeWindow = this.host.getAvailableAuthoritativeWindow()
    const offscreen = authoritativeWindow ? null : this.host.getOffscreenBrowserBackend()
    if (offscreen) {
      // Why: resolve the active page for implicit close so we don't report success while closing nothing.
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
      // Why: closeTab only destroys the guest; without retirement, paired clients keep a
      // dead session tab until an unrelated republish (closeMobileSessionTab already retires).
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
    const requestId = randomUUID()
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        ipcMain.removeListener('browser:tabCloseReply', handler)
        reject(new Error('Tab close timed out'))
      }, 10_000)

      const handler = (
        _event: Electron.IpcMainEvent,
        reply: { requestId: string; error?: string; code?: 'browser_tab_not_found' }
      ): void => {
        if (reply.requestId !== requestId) {
          return
        }
        clearTimeout(timer)
        ipcMain.removeListener('browser:tabCloseReply', handler)
        if (reply.error) {
          reject(
            reply.code === 'browser_tab_not_found'
              ? new BrowserError('browser_tab_not_found', reply.error)
              : new Error(reply.error)
          )
        } else {
          resolve()
        }
      }
      ipcMain.on('browser:tabCloseReply', handler)
      // Why: pass worktreeId so the renderer scopes the close correctly instead of falling back to the globally active tab in the wrong worktree.
      win.webContents.send('browser:requestTabClose', { requestId, tabId, worktreeId })
    })

    return { closed: true }
  }
}
