import { ipcMain } from 'electron'
import { agentHookServer, isValidPaneKey } from '../agent-hooks/server'
import {
  clearMigrationUnsupportedPtysByTabPrefix,
  clearMigrationUnsupportedPtysForPaneKey
} from '../agent-hooks/migration-unsupported-pty-state'
import { isValidAgentStatusDropTabId } from './agent-status-ipc-boundary'

/**
 * The three renderer-initiated ways a status row goes away. All fire-and-forget
 * (`ipcRenderer.send` → `ipcMain.on`), so none round-trips a response; removing the
 * listeners first keeps re-registration safe.
 *
 * They are NOT interchangeable. A dismissal keeps the pane's per-pane caches because its agent may
 * still be alive; a confirmed process exit must take them too, or a surviving Claude latch resolves
 * the pane's next event straight back to `working`.
 */
export function registerAgentStatusRowTeardownIpcHandlers(): void {
  ipcMain.removeAllListeners('agentStatus:drop')
  ipcMain.removeAllListeners('agentStatus:reconcileEndedProcess')
  ipcMain.removeAllListeners('agentStatus:dropByTabPrefix')

  ipcMain.on('agentStatus:drop', (_event, paneKey: unknown) => {
    if (typeof paneKey !== 'string' || !isValidPaneKey(paneKey)) {
      return
    }
    try {
      // Why: dropStatusEntry (not clearPaneState) is correct here — the user is
      // dismissing a status row, not tearing down a PTY. clearPaneState would also
      // wipe the per-pane prompt/tool caches, which the next hook event for that
      // (still-alive) pane needs to render a coherent row.
      agentHookServer.dropStatusEntry(paneKey)
      clearMigrationUnsupportedPtysForPaneKey(paneKey)
    } catch (err) {
      console.warn('[agent-hooks] dropStatusEntry failed:', err)
    }
  })

  ipcMain.on('agentStatus:reconcileEndedProcess', (_event, paneKey: unknown) => {
    if (typeof paneKey !== 'string' || !isValidPaneKey(paneKey)) {
      return
    }
    try {
      // Why: a process-table-confirmed agent exit is exactly the case the dismissal above excludes
      // — the pane's agent is NOT still alive — so its latches must go with the row (STA-4612).
      agentHookServer.reconcileEndedProcessForPaneKeys([paneKey], {
        // Why: this route only fires on a confirmed shell foreground, so the PTY outlived the
        // agent. The row's resume identity is still usable in that very pane — only its live
        // claims are dead.
        preserveResumeIdentity: true
      })
      clearMigrationUnsupportedPtysForPaneKey(paneKey)
    } catch (err) {
      console.warn('[agent-hooks] reconcileEndedProcessForPaneKeys failed:', err)
    }
  })

  ipcMain.on('agentStatus:dropByTabPrefix', (_event, tabId: unknown) => {
    if (!isValidAgentStatusDropTabId(tabId)) {
      return
    }
    try {
      agentHookServer.dropStatusEntriesByTabPrefix(tabId)
      clearMigrationUnsupportedPtysByTabPrefix(tabId)
    } catch (err) {
      console.warn('[agent-hooks] dropStatusEntriesByTabPrefix failed:', err)
    }
  })
}
