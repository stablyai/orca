import { ipcMain } from 'electron'
import { registerLazyIpcHandleGroup } from '../../lazy-ipc-handle-group'

const DAEMON_MANAGEMENT_IPC_CHANNELS = [
  'pty:management:listSessions',
  'pty:management:killAll',
  'pty:management:killOne',
  'pty:management:restart',
  'pty:management:macTccAttribution',
  'pty:management:resetFolderAccess',
  'pty:management:severedDaemon',
  'pty:management:restartSeveredDaemon',
  'pty:management:asyncIoHealth'
] as const

export function registerLazyDaemonManagementHandlers(): void {
  for (const channel of DAEMON_MANAGEMENT_IPC_CHANNELS) {
    ipcMain.removeHandler(channel)
  }
  registerLazyIpcHandleGroup(DAEMON_MANAGEMENT_IPC_CHANNELS, async (ipc) => {
    const { registerDaemonManagementHandlers } = await import('./pty-management')
    registerDaemonManagementHandlers(ipc)
  })
}
