// Browser tabs on a host with no window: saved as a window saves its own, and restored as a window
// restores them, lazily. A saved tab is listed to clients at once; its page starts when something
// first uses it (a tap, a command), so a restart opens no pages by itself.

import type { BrowserBackend } from '../browser/browser-backend'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { BrowserTabInfo } from '../../shared/runtime-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../shared/layout-owner-switch'
import type {
  LayoutApplyOutcome,
  LayoutCommand
} from '../../shared/workspace-layout/workspace-layout-command-types'
import {
  findSavedBrowserPage,
  savedBrowserTabEntryId,
  withClosedServeBrowserTab,
  withOpenedServeBrowserTab,
  withoutServeBrowserPages,
  withServeBrowserPageRecord,
  withServeBrowserPageState,
  type ServeBrowserPageState
} from './serve-browser-tab-layout'

type LayoutApply = (command: LayoutCommand, hostId: ExecutionHostId) => Promise<LayoutApplyOutcome>

type RestorableBrowserPage = {
  /** The saved tab; a host's own tab is named by its page, a window's by its own id. */
  tabId: string
  pageId: string
  url: string
  title: string
  profileId: string | null
  worktreeId: string
}

export class ServeBrowserTabs {
  constructor(
    private readonly deps: {
      /** The page backend while no window hosts the browser tabs, else null. */
      backend: () => BrowserBackend | null
      livePageIds: (worktreeId: string) => ReadonlySet<string>
      /** Every workspace that holds a saved browser tab, whatever else it holds. */
      savedWorktreeIds: () => Iterable<string>
      session: (worktreeId: string) => WorkspaceSessionState | null
      hostId: (worktreeId: string) => ExecutionHostId
      save: (worktreeId: string, session: WorkspaceSessionState) => void
      /** `layout.apply` on one partition; set only in a layout-owner build. */
      applyLayout?: LayoutApply
    }
  ) {}

  /** Opens main has not answered yet, by page id: the page's latest address, which the open saves. */
  private readonly pendingOpens = new Map<string, ServeBrowserPageState>()

  opened(page: ServeBrowserPageState & { profileId?: string; groupId?: string }): void {
    // Switch point: main's layout command writes the tab; the page's address is a fact saved after.
    if (ORCA_LAYOUT_OWNER_IS_MAIN && this.deps.applyLayout) {
      this.openThroughLayout(page, this.deps.applyLayout)
      return
    }
    this.write(page.worktreeId, (hostId, session) =>
      withOpenedServeBrowserTab(hostId, session, page)
    )
  }

  /** A saved tab follows its page; a page whose tab was closed is not saved again. */
  navigated(page: ServeBrowserPageState): void {
    // Switch point: an open main has not answered yet saves the page's latest address.
    if (ORCA_LAYOUT_OWNER_IS_MAIN && this.pendingOpens.has(page.pageId)) {
      this.pendingOpens.set(page.pageId, page)
      return
    }
    this.write(page.worktreeId, (_hostId, session) => withServeBrowserPageState(session, page))
  }

  /** A closed page's tab, true when one was saved; a page destroyed with the process is not a close. */
  closed(worktreeId: string, pageId: string): boolean {
    // Switch point: main's layout command closes the tab; its page records are facts dropped first.
    if (ORCA_LAYOUT_OWNER_IS_MAIN && this.deps.applyLayout) {
      return this.closeThroughLayout(worktreeId, pageId, this.deps.applyLayout)
    }
    return this.write(worktreeId, (hostId, session) =>
      withClosedServeBrowserTab(hostId, session, worktreeId, pageId)
    )
  }

  /** The unified tab showing a page, which a window keys pin and colour by: the saved one, else the page's. */
  unifiedTabId(worktreeId: string, pageId: string): string {
    const session = this.deps.session(worktreeId)
    return (session && findSavedBrowserPage(session, worktreeId, pageId)?.tabId) ?? pageId
  }

  /** Saved tabs whose page has not started, listed as running tabs are. */
  listUnstarted(worktreeId: string): BrowserTabInfo[] {
    return this.listRestorable(worktreeId).map((page, index) => ({
      browserPageId: page.pageId,
      index,
      url: page.url,
      title: page.title,
      active: false,
      worktreeId,
      ...(page.profileId ? { profileId: page.profileId } : {})
    }))
  }

  /** Saved tabs whose page has not started; every worktree's when none is named. */
  private listRestorable(worktreeId: string | undefined): RestorableBrowserPage[] {
    if (!this.deps.backend()) {
      return []
    }
    const worktreeIds = worktreeId ? [worktreeId] : new Set(this.deps.savedWorktreeIds())
    return [...worktreeIds].flatMap((id) => {
      const live = this.deps.livePageIds(id)
      return this.startableIn(id).filter((page) => !live.has(page.pageId))
    })
  }

  /**
   * Starts a saved tab's page where a window would mount it: the named page, else the worktree's
   * active tab. False when there is none, so the caller reports no tab as a window does.
   */
  async start(worktreeId: string | undefined, pageId: string | undefined): Promise<boolean> {
    const found = pageId
      ? this.listRestorable(worktreeId).find((page) => page.pageId === pageId)
      : worktreeId
        ? this.activeIn(worktreeId)
        : undefined
    return found ? this.restore(found) : false
  }

  /** The tab a window shows for a worktree with no page running: the recorded one, else the first. */
  private activeIn(worktreeId: string): RestorableBrowserPage | undefined {
    if (this.deps.livePageIds(worktreeId).size > 0) {
      return undefined
    }
    const tabs = this.startableIn(worktreeId)
    const recorded = this.deps.session(worktreeId)?.activeBrowserTabIdByWorktree?.[worktreeId]
    return tabs.find((page) => page.tabId === recorded) ?? tabs[0]
  }

  private startableIn(worktreeId: string): RestorableBrowserPage[] {
    const session = this.deps.session(worktreeId)
    if (!session) {
      return []
    }
    return (session.browserTabsByWorktree?.[worktreeId] ?? []).flatMap((tab) => {
      const pageId = tab.activePageId ?? tab.pageIds?.[0]
      const page = pageId ? findSavedBrowserPage(session, worktreeId, pageId)?.page : undefined
      // A document page is one desktop's; a remote page belongs to the host that ran it.
      if (!page || page.docLocation || page.remoteBrowserPageId) {
        return []
      }
      return [
        {
          tabId: tab.id,
          pageId: page.id,
          url: page.url,
          title: page.title,
          profileId: tab.sessionProfileId ?? null,
          worktreeId
        }
      ]
    })
  }

  // The backend registers the page before it returns, so a second caller finds it running.
  private async restore(page: RestorableBrowserPage): Promise<boolean> {
    const backend = this.deps.backend()
    if (!backend) {
      return false
    }
    await backend.createTab({
      browserPageId: page.pageId,
      url: page.url,
      worktreeId: page.worktreeId,
      ...(page.profileId ? { profileId: page.profileId } : {})
    })
    return true
  }

  private openThroughLayout(
    page: ServeBrowserPageState & { profileId?: string; groupId?: string },
    applyLayout: LayoutApply
  ): void {
    const { worktreeId, pageId } = page
    const session = this.deps.backend() ? this.deps.session(worktreeId) : null
    if (
      !session ||
      findSavedBrowserPage(session, worktreeId, pageId) ||
      this.pendingOpens.has(pageId)
    ) {
      return
    }
    this.pendingOpens.set(pageId, page)
    const command: LayoutCommand = {
      type: 'openBrowserTab',
      workspace: worktreeId,
      pageId,
      ...(page.profileId ? { profileId: page.profileId } : {}),
      ...(page.groupId ? { groupId: page.groupId } : {})
    }
    void this.applyLogged(applyLayout, worktreeId, command).then((ok) => {
      const latest = this.pendingOpens.get(pageId)
      this.pendingOpens.delete(pageId)
      if (ok && latest) {
        this.write(worktreeId, (_hostId, next) => withServeBrowserPageRecord(next, latest))
      } else if (ok) {
        // Closed while main wrote it: a host's tab is named by its page.
        void this.applyLogged(applyLayout, worktreeId, {
          type: 'closeTabs',
          workspace: worktreeId,
          tabIds: [pageId],
          force: true
        })
      }
    })
  }

  private closeThroughLayout(
    worktreeId: string,
    pageId: string,
    applyLayout: LayoutApply
  ): boolean {
    // Its open closes the tab once main answers.
    if (this.pendingOpens.delete(pageId)) {
      return true
    }
    const session = this.deps.backend() ? this.deps.session(worktreeId) : null
    const saved = session ? findSavedBrowserPage(session, worktreeId, pageId) : null
    if (!session || !saved) {
      return false
    }
    // Pages first: a tab with no saved page is listed nowhere, so the close shows at once (and a
    // refused close leaves only an unlisted tab record).
    this.write(worktreeId, (_hostId, next) => withoutServeBrowserPages(next, saved.tabId))
    void this.applyLogged(applyLayout, worktreeId, {
      type: 'closeTabs',
      workspace: worktreeId,
      tabIds: [savedBrowserTabEntryId(session, worktreeId, saved.tabId)],
      force: true
    })
    return true
  }

  /** True when main applied the command; a refusal or failure is logged, never thrown. */
  private applyLogged(
    applyLayout: LayoutApply,
    worktreeId: string,
    command: LayoutCommand
  ): Promise<boolean> {
    return applyLayout(command, this.deps.hostId(worktreeId)).then(
      (outcome) => {
        if (!outcome.ok) {
          console.warn(`[serve-browser-tabs] ${command.type} refused:`, outcome.code)
        }
        return outcome.ok
      },
      (error: unknown) => {
        console.warn(`[serve-browser-tabs] could not ${command.type}:`, error)
        return false
      }
    )
  }

  private write(
    worktreeId: string,
    change: (
      hostId: ExecutionHostId,
      session: WorkspaceSessionState
    ) => WorkspaceSessionState | null
  ): boolean {
    const session = this.deps.backend() ? this.deps.session(worktreeId) : null
    const next = session ? change(this.deps.hostId(worktreeId), session) : null
    if (!next) {
      return false
    }
    // Called from page events and closes; a refused write (writes frozen) must not throw there.
    try {
      this.deps.save(worktreeId, next)
      return true
    } catch (error) {
      console.warn('[serve-browser-tabs] could not save a browser tab:', error)
      return false
    }
  }
}
