import type { AutomationRun } from '../../../shared/automations/history/automation-run'
import { parsePaneKey } from '../../../shared/workspace-layout/stable-pane-id'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'

type WorkspaceSessionReader = Pick<OrcaRuntimeService, 'getWorkspaceSessionForWorktree'>

/** A desktop visit stamps the shown tab's focus; main-created run tabs start unstamped. */
export function runTabWasFocused(runtime: WorkspaceSessionReader, run: AutomationRun): boolean {
  const tabs = run.workspaceId
    ? runtime.getWorkspaceSessionForWorktree(run.workspaceId)?.unifiedTabs?.[run.workspaceId]
    : undefined
  return Boolean(
    tabs?.some((tab) => tab.id === run.terminalSessionId && tab.lastFocusedAt !== undefined)
  )
}

/** A sleep keeps the run's pane bound to its PTY to resume; a close or a respawned pane does not. */
export function runPaneKeepsRunPty(runtime: WorkspaceSessionReader, run: AutomationRun): boolean {
  const pane = parsePaneKey(run.terminalPaneKey ?? '')
  const layout =
    pane && run.workspaceId
      ? runtime.getWorkspaceSessionForWorktree(run.workspaceId)?.terminalLayoutsByTabId?.[
          pane.tabId
        ]
      : undefined
  return Boolean(
    pane && run.terminalPtyId && layout?.ptyIdsByLeafId?.[pane.leafId] === run.terminalPtyId
  )
}
