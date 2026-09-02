// @ts-nocheck -- mechanically split class members.
import { RuntimeBrowserCommandsWithBrowserProfileImportFromBrowser } from './runtime-browser-commands-browser-profile-import-from-browser'
import { closeRuntimeBrowserClientPage } from './runtime-browser-client-page-creation'
import { BrowserError } from '../browser/browser-error'
import { randomUUID } from 'node:crypto'
import { ipcMain } from 'electron'
import type { BrowserTabListResult } from '../../shared/runtime-types'
import { browserManager } from '../browser/browser-manager'
import { browserSessionRegistry } from '../browser/browser-session-registry'

export class RuntimeBrowserCommandsWithBrowserTabClose extends RuntimeBrowserCommandsWithBrowserProfileImportFromBrowser {
  async browserTabClose(params: {
    index?: number
    page?: string
    worktree?: string
  }): Promise<{ closed: boolean }> {
    const pages = this.host.getRuntimeBrowserPageRegistry()
    let clientPage = params.page ? pages.getPage(params.page) : undefined
    if (clientPage) {
      await this.assertClientPageWorkspace(clientPage, params.worktree)
    } else if (!params.page) {
      const workspaceId = params.worktree
        ? (await this.host.resolveBrowserWorkspace(params.worktree)).id
        : undefined
      if (pages.listPages(workspaceId).length > 0) {
        const tab =
          params.index !== undefined
            ? (await this.browserTabList({ worktree: params.worktree })).tabs[params.index]
            : (await this.browserTabCurrent({ worktree: params.worktree })).tab
        clientPage = tab ? pages.getPage(tab.browserPageId) : undefined
      }
    }
    if (clientPage) {
      const authority = this.host.getBrowserHostLeaseRegistry()
      // Why: a retained page whose host quit has no placement left to command, and asking the
      // absent host first would refuse the close and strand the tab with no way to dismiss it.
      if (authority.getPlacement(clientPage.browserPageId)) {
        await closeRuntimeBrowserClientPage(authority, {
          browserPageId: clientPage.browserPageId,
          placement: clientPage.placement
        })
      }
      if (!pages.retirePage(clientPage.browserPageId, clientPage.placement)) {
        throw new Error('browser_page_placement_stale')
      }
      if (this.host.retireRuntimeOwnedBrowserSessionTab) {
        this.host.retireRuntimeOwnedBrowserSessionTab(
          clientPage.workspaceId,
          clientPage.browserPageId
        )
      } else {
        this.host.notifyHeadlessBrowserSessionTabsChanged?.(clientPage.workspaceId)
      }
      return { closed: true }
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
        this.retireGhostBrowserSessionRow(
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
      : await this.resolveBrowserWorktreeId(params.worktree)

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
        if (this.retireGhostBrowserSessionRow(worktreeId, resolvedTabId)) {
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
      if (this.retireGhostBrowserSessionRow(worktreeId, tabId)) {
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

  protected enrichBrowserTabInfo(
    tab: BrowserTabListResult['tabs'][number]
  ): BrowserTabListResult['tabs'][number] {
    const rawProfileId = browserManager.getSessionProfileIdForTab(tab.browserPageId)
    const profile =
      browserSessionRegistry.getProfile(rawProfileId ?? 'default') ??
      browserSessionRegistry.getDefaultProfile()
    return {
      ...tab,
      worktreeId: browserManager.getWorktreeIdForTab(tab.browserPageId) ?? null,
      profileId: profile.id,
      profileLabel: profile.label
    }
  }
}
