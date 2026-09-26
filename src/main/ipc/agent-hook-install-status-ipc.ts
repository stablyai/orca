import { ipcMain } from 'electron'
import type { AgentHookInstallStatus } from '../../shared/agent-hook-types'
import { getManagedAgentHookStatuses } from '../agent-hooks/managed-agent-hook-controls'

const CHANNEL = 'agentHooks:installStatuses'

export function removeAgentHookInstallStatusIpc(): void {
  ipcMain.removeHandler(CHANNEL)
}

export function registerAgentHookInstallStatusIpc(): void {
  ipcMain.handle(CHANNEL, (): AgentHookInstallStatus[] => getManagedAgentHookStatuses())
}
