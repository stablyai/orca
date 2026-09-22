// @ts-nocheck -- mechanically split class members.
import { RuntimeBrowserCommandsWithBrowserScreencast } from './runtime-browser-commands-browser-screencast'
import type {
  BrowserCheckResult,
  BrowserDragResult,
  BrowserFocusResult,
  BrowserHoverResult,
  BrowserTabCurrentResult,
  BrowserTabListResult,
  BrowserTabShowResult,
  BrowserTabSwitchResult,
  BrowserUploadResult,
  BrowserWaitResult
} from '../../shared/runtime-types'
import type { BrowserCommandTargetParams } from './runtime-browser-commands-browser-command-target-params'
import type { BrowserCertificateProceedResult } from '../../shared/browser-workspace-types'
import { browserCertificateTrustController, browserManager } from '../browser/browser-manager'
import { BrowserError } from '../browser/browser-error'
import { publishSwitchedBrowserSessionTab } from './browser-tab-create-publication'

export class RuntimeBrowserCommandsWithBrowserTabList extends RuntimeBrowserCommandsWithBrowserScreencast {
  async browserTabList(params: { worktree?: string }): Promise<BrowserTabListResult> {
    const workspaceId = params.worktree
      ? (await this.host.resolveBrowserWorkspace(params.worktree)).id
      : undefined
    const clientPages = this.host.getRuntimeBrowserPageRegistry().listPages(workspaceId)
    let bridgeWorktreeId = workspaceId
    if (this.host.getAgentBrowserBridge()) {
      try {
        bridgeWorktreeId = await this.resolveBrowserWorktreeId(params.worktree)
      } catch (error) {
        if (clientPages.length === 0) {
          throw error
        }
      }
    }
    return { tabs: this.listLogicalBrowserTabs(bridgeWorktreeId, clientPages) }
  }

  async browserProceedCertificate(
    params: { challengeId: string } & BrowserCommandTargetParams
  ): Promise<BrowserCertificateProceedResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    if (!target.browserPageId) {
      return { ok: false, reason: 'missing' }
    }
    return browserCertificateTrustController.proceed(target.browserPageId, params.challengeId)
  }

  async browserTabShow(params: { page: string; worktree?: string }): Promise<BrowserTabShowResult> {
    const clientPage = this.host.getRuntimeBrowserPageRegistry().getPage(params.page)
    if (clientPage) {
      await this.assertClientPageWorkspace(clientPage, params.worktree)
      const tab = this.listLogicalBrowserTabs(
        clientPage.workspaceId,
        this.host.getRuntimeBrowserPageRegistry().listPages(clientPage.workspaceId)
      ).find((candidate) => candidate.browserPageId === clientPage.browserPageId)
      if (!tab) {
        throw new BrowserError('browser_tab_not_found', `Browser page ${params.page} was not found`)
      }
      return { tab }
    }
    const target = await this.resolveBrowserCommandTarget(params)
    return { tab: this.describeBrowserTab(params.page, target.worktreeId) }
  }

  async browserTabCurrent(params: { worktree?: string }): Promise<BrowserTabCurrentResult> {
    const tab = (await this.browserTabList(params)).tabs.find((candidate) => candidate.active)
    if (!tab) {
      throw new BrowserError('browser_no_tab', 'No browser tab open in this worktree')
    }
    return { tab }
  }

  async browserTabSwitch(
    params: {
      index?: number
      focus?: boolean
    } & BrowserCommandTargetParams
  ): Promise<BrowserTabSwitchResult> {
    const listed = await this.browserTabList({ worktree: params.worktree })
    const switchedIndex = params.page
      ? listed.tabs.findIndex((tab) => tab.browserPageId === params.page)
      : (params.index ?? -1)
    const selected = listed.tabs[switchedIndex]
    if (!selected) {
      const label = params.page ? `Browser page ${params.page}` : `Tab index ${params.index}`
      throw new BrowserError(
        'browser_tab_not_found',
        `${label} out of range (0-${listed.tabs.length - 1})`
      )
    }
    const clientPage = this.host.getRuntimeBrowserPageRegistry().getPage(selected.browserPageId)
    if (clientPage) {
      this.host
        .getRuntimeBrowserPageRegistry()
        .activatePage(clientPage.browserPageId, clientPage.placement)
      publishSwitchedBrowserSessionTab(this.host, {
        placementKind: 'client',
        browserPageId: clientPage.browserPageId,
        worktreeId: clientPage.workspaceId,
        focus: params.focus
      })
      return { switched: switchedIndex, browserPageId: clientPage.browserPageId }
    }
    const bridge = this.requireAgentBrowserBridge()
    const worktreeId =
      typeof selected.worktreeId === 'string'
        ? selected.worktreeId
        : params.worktree
          ? (await this.host.resolveBrowserWorkspace(params.worktree)).id
          : undefined
    const result = await bridge.tabSwitch(undefined, worktreeId, selected.browserPageId)
    this.host.getRuntimeBrowserPageRegistry().deactivateGlobal()
    if (worktreeId) {
      this.host.getRuntimeBrowserPageRegistry().deactivateWorkspace(worktreeId)
    }
    // Why: scope focus to the tab's owning worktree; the renderer never yanks the user across worktrees on this signal (see focusBrowserTabInWorktree).
    const focusWorktreeId =
      worktreeId ?? browserManager.getWorktreeIdForTab(result.browserPageId) ?? undefined
    publishSwitchedBrowserSessionTab(this.host, {
      placementKind: 'bridge',
      browserPageId: result.browserPageId,
      worktreeId: focusWorktreeId,
      focus: params.focus
    })
    if (params.focus) {
      this.notifyRendererBrowserPaneFocus(focusWorktreeId, result.browserPageId)
    }
    return { ...result, switched: switchedIndex }
  }

  async browserHover(
    params: { element: string } & BrowserCommandTargetParams
  ): Promise<BrowserHoverResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().hover(
      params.element,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserDrag(
    params: {
      from: string
      to: string
    } & BrowserCommandTargetParams
  ): Promise<BrowserDragResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().drag(
      params.from,
      params.to,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserUpload(
    params: { element: string; files: string[] } & BrowserCommandTargetParams
  ): Promise<BrowserUploadResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().upload(
      params.element,
      params.files,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserWait(
    params: {
      selector?: string
      timeout?: number
      text?: string
      url?: string
      load?: string
      fn?: string
      state?: string
    } & BrowserCommandTargetParams
  ): Promise<BrowserWaitResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    const { worktree: _, page: __, ...options } = params
    return this.requireAgentBrowserBridge().wait(options, target.worktreeId, target.browserPageId)
  }

  async browserCheck(
    params: { element: string; checked: boolean } & BrowserCommandTargetParams
  ): Promise<BrowserCheckResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().check(
      params.element,
      params.checked,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserFocus(
    params: { element: string } & BrowserCommandTargetParams
  ): Promise<BrowserFocusResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().focus(
      params.element,
      target.worktreeId,
      target.browserPageId
    )
  }
}
