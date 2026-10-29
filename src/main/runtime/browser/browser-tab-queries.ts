import type {
  BrowserTabCurrentResult,
  BrowserTabListResult,
  BrowserTabShowResult,
  BrowserTabSwitchResult
} from '../../../shared/runtime-types'
import type { BrowserCertificateProceedResult } from '../../../shared/browser-workspace-types'
import { browserCertificateTrustController, browserManager } from '../../browser/browser-manager'
import { BrowserError } from '../../browser/browser-error'
import { publishSwitchedBrowserSessionTab } from '../browser-tab-create-publication'
import type {
  BrowserCommandTargetParams,
  RuntimeBrowserCommandHost
} from './browser-command-contracts'
import type { RuntimeBrowserCommandTargets } from './browser-command-targets'
import type { RuntimeBrowserTabCatalog } from './browser-tab-catalog'

export class RuntimeBrowserTabQueries {
  constructor(
    private readonly host: Pick<
      RuntimeBrowserCommandHost,
      | 'getAgentBrowserBridge'
      | 'resolveBrowserWorkspace'
      | 'getRuntimeBrowserPageRegistry'
      | 'markHeadlessBrowserSessionTabActive'
      | 'notifyHeadlessBrowserSessionTabsChanged'
    >,
    private readonly targets: Pick<
      RuntimeBrowserCommandTargets,
      | 'requireAgentBrowserBridge'
      | 'resolveBrowserCommandTarget'
      | 'resolveBrowserWorktreeId'
      | 'notifyRendererBrowserPaneFocus'
      | 'ensureBrowserPageActive'
    >,
    private readonly catalog: Pick<
      RuntimeBrowserTabCatalog,
      'listLogicalBrowserTabs' | 'assertClientPageWorkspace' | 'describeBrowserTab'
    >
  ) {}

  async browserTabList(params: { worktree?: string }): Promise<BrowserTabListResult> {
    const workspaceId = params.worktree
      ? (await this.host.resolveBrowserWorkspace(params.worktree)).id
      : undefined
    const clientPages = this.host.getRuntimeBrowserPageRegistry().listPages(workspaceId)
    let bridgeWorktreeId = workspaceId
    if (this.host.getAgentBrowserBridge()) {
      try {
        bridgeWorktreeId = await this.targets.resolveBrowserWorktreeId(params.worktree)
      } catch (error) {
        if (clientPages.length === 0) {
          throw error
        }
      }
    }
    return { tabs: this.catalog.listLogicalBrowserTabs(bridgeWorktreeId, clientPages) }
  }

  async browserProceedCertificate(
    params: { challengeId: string } & BrowserCommandTargetParams
  ): Promise<BrowserCertificateProceedResult> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    if (!target.browserPageId) {
      return { ok: false, reason: 'missing' }
    }
    return browserCertificateTrustController.proceed(target.browserPageId, params.challengeId)
  }

  async browserTabShow(params: { page: string; worktree?: string }): Promise<BrowserTabShowResult> {
    const clientPage = this.host.getRuntimeBrowserPageRegistry().getPage(params.page)
    if (clientPage) {
      await this.catalog.assertClientPageWorkspace(clientPage, params.worktree)
      const tab = this.catalog
        .listLogicalBrowserTabs(
          clientPage.workspaceId,
          this.host.getRuntimeBrowserPageRegistry().listPages(clientPage.workspaceId)
        )
        .find((candidate) => candidate.browserPageId === clientPage.browserPageId)
      if (!tab) {
        throw new BrowserError('browser_tab_not_found', `Browser page ${params.page} was not found`)
      }
      return { tab }
    }
    const target = await this.targets.resolveBrowserCommandTarget(params)
    return { tab: this.catalog.describeBrowserTab(params.page, target.worktreeId) }
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
    if (selected.loaded === false) {
      try {
        await this.targets.ensureBrowserPageActive(
          selected.worktreeId ?? undefined,
          selected.browserPageId,
          { waitForFirstLoad: true }
        )
      } catch {
        // The switch below reports browser_tab_not_found if the page could not load.
      }
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
    const bridge = this.targets.requireAgentBrowserBridge()
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
    // Scope focus to the owning worktree; never switch the user's workspace.
    const focusWorktreeId =
      worktreeId ?? browserManager.getWorktreeIdForTab(result.browserPageId) ?? undefined
    publishSwitchedBrowserSessionTab(this.host, {
      placementKind: 'bridge',
      browserPageId: result.browserPageId,
      worktreeId: focusWorktreeId,
      focus: params.focus
    })
    if (params.focus) {
      this.targets.notifyRendererBrowserPaneFocus(focusWorktreeId, result.browserPageId)
    }
    return { ...result, switched: switchedIndex }
  }
}
