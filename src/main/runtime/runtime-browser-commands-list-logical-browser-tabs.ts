// @ts-nocheck -- mechanically split class members.
import { RuntimeBrowserCommandsWithBrowserTabClose } from './runtime-browser-commands-browser-tab-close'
import type { RuntimeBrowserClientPage } from './runtime-browser-page-registry'
import type { BrowserTabListResult } from '../../shared/runtime-types'
import { browserSessionRegistry } from '../browser/browser-session-registry'
import { BrowserError } from '../browser/browser-error'
import type { BrowserCommandTargetParams } from './runtime-browser-commands-browser-command-target-params'
import { browserManager } from '../browser/browser-manager'
import { randomUUID } from 'node:crypto'
import { ipcMain } from 'electron'

export class RuntimeBrowserCommandsWithListLogicalBrowserTabs extends RuntimeBrowserCommandsWithBrowserTabClose {
  protected listLogicalBrowserTabs(
    worktreeId: string | undefined,
    clientPages: readonly RuntimeBrowserClientPage[]
  ): BrowserTabListResult['tabs'] {
    const clientPageActive = clientPages.some((page) => page.active)
    const bridge = this.host.getAgentBrowserBridge()
    const serverTabs =
      bridge && typeof bridge.tabList === 'function'
        ? bridge.tabList(worktreeId).tabs.map((tab) => ({
            ...this.enrichBrowserTabInfo(tab),
            active: clientPageActive ? false : tab.active
          }))
        : []
    const clientTabs = clientPages.map((page, offset) => {
      const profile =
        browserSessionRegistry.getProfile(page.browserProfileId) ??
        browserSessionRegistry.getDefaultProfile()
      return {
        browserPageId: page.browserPageId,
        index: serverTabs.length + offset,
        url: page.url,
        title: page.title,
        active: page.active,
        loadError: null,
        certificateFailure: null,
        worktreeId: page.workspaceId,
        profileId: profile.id,
        profileLabel: profile.label
      }
    })
    const tabs = [...serverTabs, ...clientTabs]
    if (tabs.length > 0 && !tabs.some((tab) => tab.active)) {
      tabs[0] = { ...tabs[0]!, active: true }
    }
    return tabs.map((tab, index) => ({ ...tab, index }))
  }

  protected async assertClientPageWorkspace(
    page: RuntimeBrowserClientPage,
    selector: string | undefined
  ): Promise<void> {
    if (!selector) {
      return
    }
    const workspace = await this.host.resolveBrowserWorkspace(selector)
    if (workspace.id !== page.workspaceId) {
      throw new BrowserError(
        'browser_tab_not_found',
        `Browser page ${page.browserPageId} was not found in this worktree`
      )
    }
  }

  protected async resolveClientHostedBrowserPage(
    params: BrowserCommandTargetParams
  ): Promise<RuntimeBrowserClientPage | undefined> {
    const pages = this.host.getRuntimeBrowserPageRegistry()
    if (params.page) {
      const page = pages.getPage(params.page)
      if (page) {
        await this.assertClientPageWorkspace(page, params.worktree)
      }
      return page
    }
    const workspaceId = params.worktree
      ? (await this.host.resolveBrowserWorkspace(params.worktree)).id
      : undefined
    return pages.listPages(workspaceId).find((page) => page.active)
  }

  protected describeBrowserTab(
    browserPageId: string,
    explicitWorktreeId?: string
  ): BrowserTabListResult['tabs'][number] {
    const worktreeId = explicitWorktreeId ?? browserManager.getWorktreeIdForTab(browserPageId)
    const tab = this.requireAgentBrowserBridge()
      .tabList(worktreeId)
      .tabs.find((entry) => entry.browserPageId === browserPageId)
    if (!tab) {
      const scope = worktreeId ? ' in this worktree' : ''
      throw new BrowserError(
        'browser_tab_not_found',
        `Browser page ${browserPageId} was not found${scope}`
      )
    }
    return this.enrichBrowserTabInfo(tab)
  }

  protected async createBrowserTabInRenderer(
    url: string,
    worktreeId: string | undefined,
    profileId: string | undefined,
    sessionPartition: string | undefined,
    activate?: boolean,
    requestedPageId?: string
  ): Promise<{ browserPageId: string }> {
    const win = this.host.getAuthoritativeWindow()
    const requestId = randomUUID()

    const browserPageId = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        ipcMain.removeListener('browser:tabCreateReply', handler)
        reject(new Error('Tab creation timed out'))
      }, 10_000)

      const handler = (
        event: Electron.IpcMainEvent,
        reply: { requestId: string; browserPageId?: string; error?: string }
      ): void => {
        if (event.sender !== win.webContents || reply.requestId !== requestId) {
          return
        }
        clearTimeout(timer)
        ipcMain.removeListener('browser:tabCreateReply', handler)
        if (reply.error) {
          reject(new Error(reply.error))
        } else {
          resolve(reply.browserPageId!)
        }
      }
      ipcMain.on('browser:tabCreateReply', handler)
      win.webContents.send('browser:requestTabCreate', {
        requestId,
        url,
        worktreeId,
        ...(requestedPageId ? { browserPageId: requestedPageId } : {}),
        // Why: keep these undefined (not null) when no profile is chosen so the renderer still applies default-profile inheritance.
        sessionProfileId: profileId,
        sessionPartition,
        activate
      })
    })

    return { browserPageId }
  }
}
