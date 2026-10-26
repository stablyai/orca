// Inspect raw sessions for dropped tab-bar entries that layout reconstruction hides.

import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'

export function terminalTabBarEntries(session: WorkspaceSessionState): Map<string, Set<string>> {
  return new Map(
    Object.entries(session.unifiedTabs ?? {}).map(([workspace, entries]) => [
      workspace,
      new Set(
        entries.flatMap((entry) => (entry.contentType === 'terminal' ? [entry.entityId] : []))
      )
    ])
  )
}

function addPath(paths: Map<string, string[]>, workspace: string, path: string): void {
  paths.set(workspace, [...(paths.get(workspace) ?? []), path])
}

/** Report entries dropped while their terminal rows remain, which Loader would silently reconstruct. */
export function droppedTabBarEntries(
  wasEntries: ReadonlyMap<string, ReadonlySet<string>>,
  now: WorkspaceSessionState | null | undefined,
  paths: Map<string, string[]>
): void {
  const nowEntries = now ? terminalTabBarEntries(now) : new Map<string, Set<string>>()
  for (const [workspace, entities] of wasEntries) {
    const kept = nowEntries.get(workspace)
    // Absent bars can come from saves predating the first main frame.
    if (!kept) {
      continue
    }
    const rows = new Set((now?.tabsByWorktree?.[workspace] ?? []).map((row) => row.id))
    for (const entityId of entities) {
      if (!kept.has(entityId) && rows.has(entityId)) {
        addPath(paths, workspace, `terminal ${entityId} tab-bar entry removed`)
      }
    }
  }
}
