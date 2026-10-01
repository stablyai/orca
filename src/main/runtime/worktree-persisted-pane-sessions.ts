import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'

/**
 * Session ids this worktree's saved terminal tabs are bound to, read from the workspace session
 * main already holds. A tab restored as "owner unverified" keeps this binding while nothing else
 * in main names its session, so it is the evidence a silent daemon version may still run it.
 */
export function persistedPaneSessionIdsForWorktree(
  session:
    | Pick<WorkspaceSessionState, 'tabsByWorktree' | 'terminalLayoutsByTabId'>
    | null
    | undefined,
  worktreeId: string
): string[] {
  const ids = new Set<string>()
  for (const tab of session?.tabsByWorktree?.[worktreeId] ?? []) {
    if (tab.worktreeId !== worktreeId) {
      continue
    }
    if (typeof tab.ptyId === 'string' && tab.ptyId.length > 0) {
      ids.add(tab.ptyId)
    }
    for (const ptyId of Object.values(
      session?.terminalLayoutsByTabId?.[tab.id]?.ptyIdsByLeafId ?? {}
    )) {
      if (typeof ptyId === 'string' && ptyId.length > 0) {
        ids.add(ptyId)
      }
    }
  }
  return [...ids]
}

/** The per-worktree evidence a scoped session listing weighs, or none when no worktree was named. */
export function worktreeEvidenceScope(
  session: Parameters<typeof persistedPaneSessionIdsForWorktree>[0],
  worktreeId: string | undefined
): { worktreeId: string; persistedPaneSessionIds: string[] } | undefined {
  return worktreeId === undefined
    ? undefined
    : {
        worktreeId,
        persistedPaneSessionIds: persistedPaneSessionIdsForWorktree(session, worktreeId)
      }
}
