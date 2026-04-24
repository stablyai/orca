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
  ipcMain.handle(
    'agentHooks:claudeStatus',
    (): AgentHookInstallStatus => claudeHookService.getStatus()
  )
  ipcMain.handle(
    'agentHooks:codexStatus',
    (): AgentHookInstallStatus => codexHookService.getStatus()
  )
  ipcMain.handle(
    'agentHooks:geminiStatus',
    (): AgentHookInstallStatus => geminiHookService.getStatus()
  )
}
