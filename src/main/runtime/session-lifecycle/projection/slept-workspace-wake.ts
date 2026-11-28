// Which slept panes a workspace wake resumes, and whether main or the window resumes each one.
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/workspace-layout/layout-owner-switch'
import { parsePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { isWorkspaceSleepRecord } from '../../../../shared/workspace/lifecycle/workspace-sleep'
import { worktreeIdsEqual } from '../../../../shared/worktree/id'
import { mainOwnsTabLayout } from '../../terminal/launch/main-owned-tab-layout'
import type { RestoredPane } from '../../terminal/recovery/restored-pane-start'
import { isUnclaimedRunningSleepRecord } from './sleep-record-pane-claim'

type SleptPaneLayout = {
  hostIdsForTab: (worktreeId: string, tabId: string) => ExecutionHostId[]
  /** The pane's stored terminal; null once main's layout no longer holds the pane. */
  binding: (pane: RestoredPane) => string | null | undefined
}

/** Main resumes a slept pane its layout owns and still holds. A record whose tab is gone stays
 *  the window's, which reopens it in a fresh tab. */
export function mainHoldsSleptPane(
  layout: SleptPaneLayout,
  worktreeId: string,
  paneKey: string
): boolean {
  const pane = parsePaneKey(paneKey)
  return (
    ORCA_LAYOUT_OWNER_IS_MAIN &&
    !!pane &&
    mainOwnsTabLayout(layout.hostIdsForTab(worktreeId, pane.tabId)) &&
    layout.binding({ worktreeId, tabId: pane.tabId, leafId: pane.leafId }) !== null
  )
}

/** A workspace sleep's running agents; where main holds the pane, also what the window resumed
 *  before (hibernated and quit agents), but never a tab-open-only pane (#11598). */
export function workspaceWakePanes(
  records: Readonly<Record<string, SleepingAgentSessionRecord>> | undefined,
  worktreeId: string,
  mainHolds: (paneKey: string) => boolean
): RestoredPane[] {
  return Object.values(records ?? {}).flatMap((record) => {
    const pane = parsePaneKey(record.paneKey)
    const woken =
      worktreeIdsEqual(record.worktreeId, worktreeId) &&
      (isUnclaimedRunningSleepRecord(record) ||
        (!isWorkspaceSleepRecord(record) &&
          record.restoreOnTabOpenOnly !== true &&
          mainHolds(record.paneKey)))
    return pane && woken ? [{ worktreeId, tabId: pane.tabId, leafId: pane.leafId }] : []
  })
}
