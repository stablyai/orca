import type { RuntimeTerminalWatchFocus } from '../../../../shared/runtime-terminal-contracts'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import { isTerminalLeafId, makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { activeSessionWorkspaceId } from '../wait/active-worktree-context-fallback'

type RuntimeFocusedTerminalDependencies = {
  /** False while no desktop window publishes the graph: a headless host focuses nothing. */
  hasWindowGraph(): boolean
  /** The window's saved selection (the local partition). */
  getSelection(): WorkspaceSessionState | null | undefined
  /** The partition holding a workspace's own rows, which may be its host's. */
  getWorkspaceSession(worktreeId: string): WorkspaceSessionState | null | undefined
  getHandleForPaneKey(paneKey: string): string | null
  /** Push sources a watch re-reads on: window selection writes and terminal graph changes. */
  onSelectionWritten(listener: () => void): () => void
  onGraphChanged(listener: () => void): () => void
}

/** The pane the desktop window has focused, read from the selection the window saves. */
export class RuntimeFocusedTerminal {
  constructor(private readonly deps: RuntimeFocusedTerminalDependencies) {}

  /** Null while the window shows another kind of tab, or no window is open. */
  handle(): string | null {
    const paneKey = this.deps.hasWindowGraph() ? this.paneKey() : null
    return paneKey ? this.deps.getHandleForPaneKey(paneKey) : null
  }

  /** Answers once the focused handle differs from `after` (at once without one), else at the deadline or abort. */
  waitForChange(
    after: string | null | undefined,
    options: { timeoutMs: number; signal?: AbortSignal }
  ): Promise<RuntimeTerminalWatchFocus> {
    const { signal, timeoutMs } = options
    const current = this.handle()
    if (current !== after || signal?.aborted) {
      return Promise.resolve({ handle: current })
    }
    return new Promise((resolve) => {
      let settled = false
      let checkQueued = false
      const stops: (() => void)[] = []
      const finish = (): void => {
        if (settled) {
          return
        }
        settled = true
        for (const stop of stops) {
          stop()
        }
        resolve({ handle: this.handle() })
      }
      // A microtask later: graph listeners fire mid-sync, before the graph is marked ready.
      const check = (): void => {
        if (checkQueued || settled) {
          return
        }
        checkQueued = true
        queueMicrotask(() => {
          checkQueued = false
          if (this.handle() !== after) {
            finish()
          }
        })
      }
      const timer = setTimeout(finish, timeoutMs)
      signal?.addEventListener('abort', finish, { once: true })
      stops.push(
        this.deps.onSelectionWritten(check),
        this.deps.onGraphChanged(check),
        () => clearTimeout(timer),
        () => signal?.removeEventListener('abort', finish)
      )
    })
  }

  private paneKey(): string | null {
    const selection = this.deps.getSelection()
    const worktreeId = activeSessionWorkspaceId(selection)
    if (!selection || !worktreeId) {
      return null
    }
    // Worktree- and tab-keyed rows go to the workspace's host partition; the selection stays local.
    const owner = this.deps.getWorkspaceSession(worktreeId)
    const tabType =
      owner?.activeTabTypeByWorktree?.[worktreeId] ??
      selection.activeTabTypeByWorktree?.[worktreeId]
    // An absent type is a terminal, as the window restores it.
    if (tabType !== undefined && tabType !== 'terminal') {
      return null
    }
    const tabId =
      selection.activeTabId ??
      owner?.activeTabIdByWorktree?.[worktreeId] ??
      selection.activeTabIdByWorktree?.[worktreeId]
    const layout = tabId
      ? (owner?.terminalLayoutsByTabId?.[tabId] ?? selection.terminalLayoutsByTabId?.[tabId])
      : undefined
    const leafId = layout?.activeLeafId
    return tabId && !tabId.includes(':') && leafId && isTerminalLeafId(leafId)
      ? makePaneKey(tabId, leafId)
      : null
  }
}
