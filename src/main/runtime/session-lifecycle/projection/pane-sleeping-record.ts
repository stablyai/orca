import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import { findLegacyNumericSleepingRecord } from '../../../../shared/sleeping-record-legacy-pane-key'
import { makePaneKey, parseLegacyNumericPaneKey } from '../../../../shared/stable-pane-id'
import { resolveRuntimePaneTitleLeafIdFromRoot } from '../../../../shared/runtime-pane-title-leaf-id'
import { worktreeIdsEqual } from '../../../../shared/worktree/id'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import { collectPersistedTerminalLeafIds } from '../../mobile-session-layout-projection'

/** The pane's record and, for a numbered one, its tab's numbered keys: aliases, not other panes. */
export function findPaneSleepingRecord(
  session: WorkspaceSessionState | null | undefined,
  worktreeId: string,
  pane: { parentTabId: string; leafId: string }
): { record: SleepingAgentSessionRecord; aliases: readonly string[] } | null {
  const records = session?.sleepingAgentSessionsByPaneKey
  const record = records?.[makePaneKey(pane.parentTabId, pane.leafId)]
  if (record) {
    return worktreeIdsEqual(record.worktreeId, worktreeId) ? { record, aliases: [] } : null
  }
  if (!ORCA_LAYOUT_OWNER_IS_MAIN || !records) {
    return null
  }
  // The pane numbers the tab's records name, mapped to panes as the window numbers a restored tab.
  const root = layoutOf(session, pane)?.root
  const inWorkspace = (candidate: SleepingAgentSessionRecord) =>
    worktreeIdsEqual(candidate.worktreeId, worktreeId)
  const owned = Object.entries(records).flatMap(([paneKey, candidate]) => {
    const legacy = parseLegacyNumericPaneKey(paneKey)
    if (legacy?.tabId !== pane.parentTabId || !inWorkspace(candidate)) {
      return []
    }
    const leafId = resolveRuntimePaneTitleLeafIdFromRoot(root, legacy.numericPaneId)
    return leafId ? [{ leafId, numericPaneId: legacy.numericPaneId }] : []
  })
  const numericPaneId = owned.find((entry) => entry.leafId === pane.leafId)?.numericPaneId
  const found = findLegacyNumericSleepingRecord(
    records,
    { tabId: pane.parentTabId, numericPaneId },
    inWorkspace
  )
  const exact = parseLegacyNumericPaneKey(found?.paneKey)?.numericPaneId === numericPaneId
  // Only pane 1 may take an unowned fallback, and only with no numbered owner, or two panes could resume one conversation.
  const fallback =
    collectPersistedTerminalLeafIds(layoutOf(session, pane)).length <= 1 ||
    (owned.length === 0 && resolveRuntimePaneTitleLeafIdFromRoot(root, '1') === pane.leafId)
  return found && (exact || fallback) ? found : null
}

function layoutOf(
  session: WorkspaceSessionState | null | undefined,
  pane: { parentTabId: string }
) {
  return session?.terminalLayoutsByTabId?.[pane.parentTabId]
}
