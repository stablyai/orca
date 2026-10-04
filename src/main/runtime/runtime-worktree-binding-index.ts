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

type PersistedPtyPaneBinding = { worktreeId: string; tabId: string; paneKey: string }

function indexPersistedPtyPanes(
  session: WorkspaceSessionState | null | undefined,
  includePane: (paneKey: string) => boolean
): ReadonlyMap<string, PersistedPtyPaneBinding> {
  const bindingByPtyId = new Map<string, PersistedPtyPaneBinding>()
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
        if (!includePane(paneKey)) {
          continue
        }
        const binding = { worktreeId, tabId: tab.id, paneKey }
        const existing = bindingByPtyId.get(ptyId)
        if (existing && (existing.worktreeId !== worktreeId || existing.paneKey !== paneKey)) {
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

/** Saved pane addresses only; not proof that a process incarnation still owns them. */
export function indexPersistedPtyPaneBindings(
  session: WorkspaceSessionState | null | undefined
): ReadonlyMap<string, PersistedPtyPaneBinding> {
  return indexPersistedPtyPanes(session, () => true)
}

export function indexPersistedPtySurfaceBindings(
  session: WorkspaceSessionState | null | undefined
): ReadonlyMap<string, PersistedPtyPaneBinding & { incarnationId: string }> {
  const result = new Map<string, PersistedPtyPaneBinding & { incarnationId: string }>()
  const panes = indexPersistedPtyPanes(session, (paneKey) =>
    Boolean(session?.terminalPtyIncarnationsByPaneKey?.[paneKey])
  )
  for (const [ptyId, binding] of panes) {
    const incarnationId = session?.terminalPtyIncarnationsByPaneKey?.[binding.paneKey]
    if (incarnationId) {
      result.set(ptyId, { ...binding, incarnationId })
    }
  }
  return result
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
