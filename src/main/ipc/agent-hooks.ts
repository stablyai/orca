import { ipcMain } from 'electron'
import type { AgentHookInstallStatus } from '../../shared/agent-hook-types'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import { agentHookServer, isValidPaneKey } from '../agent-hooks/server'
import { claudeHookService } from '../claude/hook-service'
import { codexHookService } from '../codex/hook-service'
import { geminiHookService } from '../gemini/hook-service'
import { cursorHookService } from '../cursor/hook-service'

// Why: install/remove are intentionally not exposed to the renderer. Orca
// auto-installs managed hooks at app startup (see src/main/index.ts), so a
// renderer-triggered remove would be silently reverted on the next launch
// and mislead the user.
export function registerAgentHookHandlers(): void {
  // Why: matches the defensive pattern in src/main/ipc/pty.ts so re-registration
  // never throws "Attempted to register a second handler..." if this function is
  // ever invoked more than once (e.g. the macOS app re-activation path that
  // recreates the main window). Today the module-level `registered` guard in
  // register-core-handlers.ts prevents re-entry, but decoupling from that guard
  // future-proofs this file.
  ipcMain.removeHandler('agentHooks:claudeStatus')
  ipcMain.removeHandler('agentHooks:codexStatus')
  ipcMain.removeHandler('agentHooks:geminiStatus')
  ipcMain.removeHandler('agentHooks:cursorStatus')
  ipcMain.removeHandler('agentStatus:getSnapshot')
  // Why: agentStatus:drop is sent fire-and-forget from the renderer via
  // ipcRenderer.send(); we listen with ipcMain.on (not handle) so we don't
  // round-trip a response. Removing first keeps re-registration safe even
  // though the module-level registered guard already prevents re-entry today.
  ipcMain.removeAllListeners('agentStatus:drop')
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
    } catch (err) {
      console.warn('[agent-hooks] dropStatusEntry failed:', err)
    }
  })
  ipcMain.handle('agentStatus:getSnapshot', (): AgentStatusIpcPayload[] => {
    // Why: the renderer pulls this after workspace hydration, so startup cannot
    // lose replayed statuses while its local store is still empty.
    return agentHookServer.getStatusSnapshot()
  })

  // Why: errors from getStatus() (fs permission denied, homedir resolution
  // failure, etc.) must be reported inline via state:'error' so the sidebar can
  // render a coherent per-agent error row. Letting the exception propagate out
  // of the IPC handler surfaces as an unhandled renderer-side rejection, which
  // defeats the AgentHookInstallStatus contract the UI relies on.
  ipcMain.handle('agentHooks:claudeStatus', (): AgentHookInstallStatus => {
    try {
      return claudeHookService.getStatus()
    } catch (err) {
      return {
        agent: 'claude',
        state: 'error',
        configPath: '',
        managedHooksPresent: false,
        detail: err instanceof Error ? err.message : String(err)
      }
    }
  })
  ipcMain.handle('agentHooks:codexStatus', (): AgentHookInstallStatus => {
    try {
      return codexHookService.getStatus()
    } catch (err) {
      return {
        agent: 'codex',
        state: 'error',
        configPath: '',
        managedHooksPresent: false,
        detail: err instanceof Error ? err.message : String(err)
      }
    }
  })
  ipcMain.handle('agentHooks:geminiStatus', (): AgentHookInstallStatus => {
    try {
      return geminiHookService.getStatus()
    } catch (err) {
      return {
        agent: 'gemini',
        state: 'error',
        configPath: '',
        managedHooksPresent: false,
        detail: err instanceof Error ? err.message : String(err)
      }
    }
  })
  ipcMain.handle('agentHooks:cursorStatus', (): AgentHookInstallStatus => {
    try {
      return cursorHookService.getStatus()
    } catch (err) {
      return {
        agent: 'cursor',
        state: 'error',
        configPath: '',
        managedHooksPresent: false,
        detail: err instanceof Error ? err.message : String(err)
      }
    }
  })
}
