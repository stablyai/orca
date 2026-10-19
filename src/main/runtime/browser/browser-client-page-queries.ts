import { BrowserError } from '../../browser/browser-error'
import type {
  BrowserTabInfo,
  BrowserTabListResult,
  BrowserTabShowResult,
  BrowserTabSwitchResult
} from '../../../shared/runtime-types'
import { publishSwitchedBrowserSessionTab } from '../browser-tab-create-publication'
import type { RuntimeBrowserClientPage } from '../runtime-browser-page-registry'
import type { RuntimeBrowserCommandHost } from './browser-command-contracts'

type BrowserProfileLabel = { id: string; label: string }

// Why no Electron import: a host with no engine lists and selects the pages a desktop hosts for it.
export type BrowserClientPageQueryHost = Pick<
  RuntimeBrowserCommandHost,
  | 'getAgentBrowserBridge'
  | 'resolveBrowserWorkspace'
  | 'getRuntimeBrowserPageRegistry'
  | 'markHeadlessBrowserSessionTabActive'
  | 'notifyHeadlessBrowserSessionTabsChanged'
>

/** The tabs a host's own engine holds, beside the pages desktops host for it. */
export type BrowserEngineTabs = {
  list(params: { worktree?: string }): Promise<BrowserTabListResult>
  /** The engine's own per-workspace selection, which its list's global flags do not show. */
  current(params: { worktree?: string }): Promise<BrowserTabShowResult>
  switchTo(params: {
    page: string
    worktree?: string
    focus?: boolean
  }): Promise<BrowserTabSwitchResult>
}

/**
 * One logical tab list per host: its engine's tabs (if any), then the pages desktops host for it.
 * "Current" is what workspace automation without --page drives: the active client page, which the
 * dispatcher routes to first, else the engine's own active tab. Nothing invents a current tab.
 */
export class BrowserClientPageQueries {
  constructor(
    private readonly host: BrowserClientPageQueryHost,
    private readonly profileFor: (browserProfileId: string) => BrowserProfileLabel,
    private readonly engine: BrowserEngineTabs | null
  ) {}

  async browserTabList(params: { worktree?: string }): Promise<BrowserTabListResult> {
    const workspaceId = params.worktree
      ? (await this.host.resolveBrowserWorkspace(params.worktree)).id
      : undefined
    const pages = this.host.getRuntimeBrowserPageRegistry().listPages(workspaceId)
    const clientPageActive = pages.some((page) => page.active)
    const engineTabs = this.engine
      ? (await this.engine.list(params)).tabs.map((tab) => ({
          ...tab,
          active: clientPageActive ? false : tab.active
        }))
      : []
    const tabs = [
      ...engineTabs,
      ...pages.map((page) => clientPageTabRow(page, this.profileFor(page.browserProfileId)))
    ]
    return { tabs: tabs.map((tab, index) => ({ ...tab, index })) }
  }

  async browserTabCurrent(params: { worktree?: string }): Promise<BrowserTabShowResult> {
    // Why only within a workspace: unscoped automation never routes to a client page either.
    const listed = params.worktree ? await this.browserTabList(params) : { tabs: [] }
    const clientTab = listed.tabs.find(
      (candidate) =>
        candidate.active &&
        this.host.getRuntimeBrowserPageRegistry().getPage(candidate.browserPageId)
    )
    if (clientTab) {
      return { tab: clientTab }
    }
    if (this.engine) {
      // Why the engine's own answer: engine tabs come first, so its index is the logical one.
      return this.engine.current(params)
    }
    throw new BrowserError('browser_no_tab', 'No browser tab open in this worktree')
  }

  async browserTabShow(params: { page: string; worktree?: string }): Promise<BrowserTabShowResult> {
    const page = this.host.getRuntimeBrowserPageRegistry().getPage(params.page)
    const worktree = params.worktree ?? (page ? `id:${page.workspaceId}` : undefined)
    const tab = (await this.browserTabList({ worktree })).tabs.find(
      (candidate) => candidate.browserPageId === params.page
    )
    if (!tab) {
      throw new BrowserError('browser_tab_not_found', `Browser page ${params.page} was not found`)
    }
    return { tab }
  }

  async browserTabSwitch(params: {
    index?: number
    page?: string
    worktree?: string
    focus?: boolean
  }): Promise<BrowserTabSwitchResult> {
    const listed = await this.browserTabList({ worktree: params.worktree })
    const switched = params.page
      ? listed.tabs.findIndex((tab) => tab.browserPageId === params.page)
      : (params.index ?? -1)
    const selected = listed.tabs[switched]
    const pages = this.host.getRuntimeBrowserPageRegistry()
    const page = selected ? pages.getPage(selected.browserPageId) : undefined
    if (page) {
      pages.activatePage(page.browserPageId, page.placement)
      publishSwitchedBrowserSessionTab(this.host, {
        placementKind: 'client',
        browserPageId: page.browserPageId,
        worktreeId: page.workspaceId,
        focus: params.focus
      })
      return { switched, browserPageId: page.browserPageId }
    }
    if (!selected || !this.engine) {
      const label = params.page ? `Browser page ${params.page}` : `Tab index ${params.index}`
      throw new BrowserError(
        'browser_tab_not_found',
        `${label} out of range (0-${listed.tabs.length - 1})`
      )
    }
    const result = await this.engine.switchTo({
      page: selected.browserPageId,
      ...(params.worktree ? { worktree: params.worktree } : {}),
      ...(params.focus !== undefined ? { focus: params.focus } : {})
    })
    await yieldClientPageSelection(
      this.host,
      params.worktree ?? (selected.worktreeId ? `id:${selected.worktreeId}` : undefined)
    )
    return { switched, browserPageId: result.browserPageId }
  }
}

function clientPageTabRow(
  page: RuntimeBrowserClientPage,
  profile: BrowserProfileLabel
): BrowserTabInfo {
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
}

/**
 * Once an engine tab is created or selected it leads, so no client page may still claim to be
 * active and keep taking workspace automation. With no workspace to scope it to (an engine that
 * does not report one), every client page steps back: guessing a workspace would misroute.
 */
export async function yieldClientPageSelection(
  host: Pick<
    BrowserClientPageQueryHost,
    'getRuntimeBrowserPageRegistry' | 'resolveBrowserWorkspace'
  >,
  worktree: string | undefined
): Promise<void> {
  const pages = host.getRuntimeBrowserPageRegistry()
  pages.deactivateGlobal()
  const workspaceIds = worktree
    ? [(await host.resolveBrowserWorkspace(worktree)).id]
    : [...new Set(pages.listPages().map((page) => page.workspaceId))]
  for (const workspaceId of workspaceIds) {
    pages.deactivateWorkspace(workspaceId)
  }
}
