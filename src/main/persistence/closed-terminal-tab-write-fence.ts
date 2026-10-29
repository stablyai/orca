import { SessionUnitReader } from '../../shared/session-unit-reader'
import { SessionUnitIndex } from '../../shared/session-unit-index'
import {
  hasClosedTerminalTabRecord,
  pruneClosedTerminalTabTombstones
} from '../../shared/closed-terminal-tab-tombstones'
import {
  reduceTerminalTabClose,
  workspaceSessionListsTerminalTab
} from '../../shared/workspace-session-terminal-tab-close'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'

/** Suppress recorded closes across all writers until TTL expiry; failed-close rollback bypasses the fence. */
export function dropClosedTerminalTabs(
  session: WorkspaceSessionState,
  now = Date.now()
): WorkspaceSessionState {
  const reader = new SessionUnitReader(session, new SessionUnitIndex(session))
  reduceClosedTerminalTabFence(
    reader,
    Object.keys(session.closedTerminalTabTombstonesByTabId ?? {}),
    now
  )
  return reader.snapshot()
}

export function reduceClosedTerminalTabFence(
  reader: SessionUnitReader,
  tabIds: Iterable<string>,
  now = Date.now()
): void {
  for (const tabId of tabIds) {
    const record = reader.unit('closedTerminalTabTombstonesByTabId', tabId).value
    if (
      record &&
      hasClosedTerminalTabRecord({ [tabId]: record }, tabId, undefined, now) &&
      workspaceSessionListsTerminalTab(reader, record.worktreeId, tabId)
    ) {
      reduceTerminalTabClose(reader, record.worktreeId, tabId, { force: true })
    }
  }
}

/** A recorded close owns pruning the complete host field, including an empty result. */
export function reduceClosedTerminalTabPruning(reader: SessionUnitReader, now: number): void {
  reader.replace('closedTerminalTabTombstonesByTabId', {
    present: true,
    value: pruneClosedTerminalTabTombstones(
      reader.map(
        'closedTerminalTabTombstonesByTabId',
        reader.keys('closedTerminalTabTombstonesByTabId')
      ),
      now
    )
  })
}
