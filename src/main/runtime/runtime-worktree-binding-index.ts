import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { makePaneKey } from '../../shared/stable-pane-id'

export function indexPersistedPtyWorktreeBindings(
  session: WorkspaceSessionState | null | undefined
): ReadonlyMap<string, string> {
  const worktreeIdByPtyId = new Map<string, string>()
  const ambiguousPtyIds = new Set<string>()
  const bind = (ptyId: string | null | undefined, worktreeId: string): void => {
    if (!ptyId || ambiguousPtyIds.has(ptyId)) {
      return
    }
    const existingWorktreeId = worktreeIdByPtyId.get(ptyId)
    if (existingWorktreeId && existingWorktreeId !== worktreeId) {
      // Why: a corrupt/stale duplicate binding must not attribute a live PTY to whichever workspace was visited first.
      worktreeIdByPtyId.delete(ptyId)
      ambiguousPtyIds.add(ptyId)
      return
    }
    worktreeIdByPtyId.set(ptyId, worktreeId)
  }

  for (const [worktreeId, tabs] of Object.entries(session?.tabsByWorktree ?? {})) {
    for (const tab of tabs) {
      bind(tab.ptyId, worktreeId)
      bind(session?.remoteSessionIdsByTabId?.[tab.id], worktreeId)
      const layout = session?.terminalLayoutsByTabId[tab.id]
      for (const ptyId of Object.values(layout?.ptyIdsByLeafId ?? {})) {
        bind(ptyId, worktreeId)
      }
    }
  }
  return worktreeIdByPtyId
}

export function indexPersistedPtySurfaceBindings(
  session: WorkspaceSessionState | null | undefined
): ReadonlyMap<
  string,
  { worktreeId: string; tabId: string; paneKey: string; incarnationId: string }
> {
  const bindingByPtyId = new Map<
    string,
    { worktreeId: string; tabId: string; paneKey: string; incarnationId: string }
  >()
  const ambiguousPtyIds = new Set<string>()
  for (const [worktreeId, tabs] of Object.entries(session?.tabsByWorktree ?? {})) {
    for (const tab of tabs) {
      for (const [leafId, ptyId] of Object.entries(
        session?.terminalLayoutsByTabId[tab.id]?.ptyIdsByLeafId ?? {}
      )) {
        if (!ptyId || ambiguousPtyIds.has(ptyId)) {
          continue
        }
        const paneKey = makePaneKey(tab.id, leafId)
        const incarnationId = session?.terminalPtyIncarnationsByPaneKey?.[paneKey]
        if (!incarnationId) {
          continue
        }
        const binding = { worktreeId, tabId: tab.id, paneKey, incarnationId }
        const existing = bindingByPtyId.get(ptyId)
        if (
          existing &&
          (existing.worktreeId !== worktreeId ||
            existing.paneKey !== paneKey ||
            existing.incarnationId !== incarnationId)
        ) {
          bindingByPtyId.delete(ptyId)
          ambiguousPtyIds.add(ptyId)
          continue
        }
        bindingByPtyId.set(ptyId, binding)
      }
    }
  }
  return bindingByPtyId
}

export function setsEqual<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): boolean {
  if (a.size !== b.size) {
    return false
  }
  for (const value of a) {
    if (!b.has(value)) {
      return false
    }
  }
  return true
}
