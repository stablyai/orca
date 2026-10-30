import type { RuntimeBrowserClientPage } from '../runtime-browser-page-registry'
import type { BrowserTabListResult } from '../../../shared/runtime-types'
import { browserSessionRegistry } from '../../browser/browser-session-registry'
import { mergeBrowserTabListing } from './browser-tab-listing'
import { BrowserError } from '../../browser/browser-error'
import { browserManager } from '../../browser/browser-manager'
import type {
  BrowserCommandTargetParams,
  RuntimeBrowserCommandHost
} from './browser-command-contracts'
import type { RuntimeBrowserCommandTargets } from './browser-command-targets'

export class RuntimeBrowserTabCatalog {
  constructor(
    private readonly host: Pick<
      RuntimeBrowserCommandHost,
      | 'getAgentBrowserBridge'
      | 'resolveBrowserWorkspace'
      | 'getRuntimeBrowserPageRegistry'
      | 'readBrowserTabBar'
    >,
    private readonly targets: Pick<RuntimeBrowserCommandTargets, 'requireAgentBrowserBridge'>
  ) {}

  listLogicalBrowserTabs(
    worktreeId: string | undefined,
    clientPages: readonly RuntimeBrowserClientPage[]
  ): BrowserTabListResult['tabs'] {
    const clientPageActive = clientPages.some((page) => page.active)
    const bridge = this.host.getAgentBrowserBridge()
    const liveTabs =
      bridge && typeof bridge.tabList === 'function'
        ? bridge.tabList(worktreeId).tabs.map((tab) => ({
            ...this.enrichBrowserTabInfo(tab),
            active: clientPageActive ? false : tab.active
          }))
        : []
    const clientTabs = clientPages.map((page) => {
      const profile =
        browserSessionRegistry.getProfile(page.browserProfileId) ??
        browserSessionRegistry.getDefaultProfile()
      return {
        browserPageId: page.browserPageId,
        index: 0,
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
    // Why no window check: headless snapshots list saved pages not yet started, which load on switch too.
    const tabBar = bridge ? (this.host.readBrowserTabBar?.(worktreeId) ?? []) : []
    return mergeBrowserTabListing({ tabBar, liveTabs, clientTabs })
  }

  async assertClientPageWorkspace(
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

  async resolveClientHostedBrowserPage(
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

  describeBrowserTab(
    browserPageId: string,
    explicitWorktreeId?: string
  ): BrowserTabListResult['tabs'][number] {
    const worktreeId = explicitWorktreeId ?? browserManager.getWorktreeIdForTab(browserPageId)
    const tab = this.targets
      .requireAgentBrowserBridge()
      .tabList(worktreeId)
      .tabs.find((entry) => entry.browserPageId === browserPageId)
    if (!tab) {
      const scope = worktreeId ? ' in this worktree' : ''
      throw new BrowserError(
        'browser_tab_not_found',
        `Browser page ${browserPageId} was not found${scope}`
      )
    }
    // Why the caller's scope: the index must be the one `tab list`, `switch` and `close` use there.
    const listed = this.listLogicalBrowserTabs(
      explicitWorktreeId,
      this.host.getRuntimeBrowserPageRegistry().listPages(explicitWorktreeId)
    ).find((entry) => entry.browserPageId === browserPageId)
    return listed ?? this.enrichBrowserTabInfo(tab)
  }

  private enrichBrowserTabInfo(
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
