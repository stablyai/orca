import { toSessionTabs, type RawTab, type SessionTab } from './session-tab'
import type { FocusedTabPane } from './focused-tab-pane'

type ListAllResult = { snapshots?: { worktree?: string; tabs?: RawTab[] }[] }

/** A minimal RPC surface; RuntimeClient satisfies it structurally. */
type RpcClient = {
  call<T>(method: string, params?: unknown): Promise<{ result: T }>
}

/** Polls session.tabs.listAll (every tab of every worktree — terminals, files,
 *  markdown, browser), groups them by worktree id, and keeps the focused pane's
 *  tab valid for the selected worktree. Source for both the nested sidebar tab
 *  lines and the right-pane tab strip. */
export class SessionTabsRegistry {
  private byWorktree = new Map<string, SessionTab[]>()
  private token = 0

  constructor(
    private readonly client: RpcClient,
    private readonly pane: FocusedTabPane,
    private readonly selectedWorktreeId: () => string | undefined,
    private readonly onChange: () => void
  ) {}

  get byWorktreeMap(): ReadonlyMap<string, readonly SessionTab[]> {
    return this.byWorktree
  }

  forWorktree(worktreeId: string | undefined): SessionTab[] {
    return (worktreeId ? this.byWorktree.get(worktreeId) : undefined)?.slice() ?? []
  }

  /** The selected worktree's tabs (right-pane strip + nesting). */
  forSelected(): SessionTab[] {
    return this.forWorktree(this.selectedWorktreeId())
  }

  /** Reload all tabs, then keep the focused tab valid for the selected worktree. */
  async sync(): Promise<void> {
    await this.reload()
    this.ensureFocused()
  }

  /** Keep the pane's tab valid for the selected worktree. When the same tab is
   *  still focused, refresh it (a terminal that just became ready needs its live
   *  source armed). Never discard a dirty editor on a transient list drop. */
  ensureFocused(): void {
    const refs = this.forSelected()
    const current = refs.find((tab) => tab.id === this.pane.tabId)
    if (current) {
      this.pane.refresh(current)
    } else if (this.pane.editState !== 'dirty' && this.pane.editState !== 'conflict') {
      this.pane.setTab(refs[0] ?? null)
    }
  }

  /** Resolve a tab by id and tell the runtime it's now active (so the desktop
   *  app / other clients stay in sync), returning it for the pane to show. */
  focus(tabId: string): SessionTab | null {
    const tab = this.find(tabId) ?? null
    if (tab) {
      this.activate(tab)
    }
    return tab
  }

  private activate(tab: SessionTab): void {
    void this.client
      .call('session.tabs.activate', { worktree: `id:${tab.worktreeId}`, tabId: tab.id })
      .catch(() => {
        // Best-effort sync; the TUI still shows the tab locally if it fails.
      })
  }

  /** Focus the (already-open) tab for a just-opened file path, if present. */
  focusOpened(relativePath: string): void {
    const opened = this.forSelected().find((tab) => tab.relativePath === relativePath)
    if (opened) {
      this.activate(opened)
      this.pane.setTab(opened)
      this.pane.focusInput()
    }
  }

  /** Find a tab across all worktrees by id (for resolving a jump target). */
  find(tabId: string): SessionTab | undefined {
    for (const tabs of this.byWorktree.values()) {
      const hit = tabs.find((tab) => tab.id === tabId)
      if (hit) {
        return hit
      }
    }
    return undefined
  }

  async reload(): Promise<void> {
    const token = ++this.token
    try {
      const { result } = await this.client.call<ListAllResult>('session.tabs.listAll', {})
      if (token !== this.token) {
        return
      }
      const map = new Map<string, SessionTab[]>()
      for (const snapshot of result.snapshots ?? []) {
        const worktreeId = typeof snapshot.worktree === 'string' ? snapshot.worktree : ''
        if (worktreeId) {
          map.set(worktreeId, toSessionTabs(worktreeId, snapshot.tabs ?? []))
        }
      }
      this.byWorktree = map
    } catch {
      // Keep the last map on a transient failure; the next poll re-syncs.
    }
    this.onChange()
  }
}
