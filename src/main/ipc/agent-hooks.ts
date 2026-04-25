import { ipcMain } from 'electron'
import type { AgentHookInstallStatus } from '../../shared/agent-hook-types'
import { claudeHookService } from '../claude/hook-service'
import { codexHookService } from '../codex/hook-service'
import { geminiHookService } from '../gemini/hook-service'

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
}
