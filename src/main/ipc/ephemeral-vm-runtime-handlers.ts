import { app, ipcMain } from 'electron'
import type { Store } from '../persistence'
import { createEphemeralVmRuntimeHost } from './ephemeral-vm-runtime-host'
export type { EphemeralVmCleanupCommandResult } from './ephemeral-vm-runtime-host'
export function registerEphemeralVmRuntimeHandlers(store: Store): void {
  const host = createEphemeralVmRuntimeHost(store, () => app.getPath('userData'))
  ipcMain.removeHandler('ephemeralVm:listRuntimes')
  ipcMain.handle('ephemeralVm:listRuntimes', () => host.listRuntimes())
  ipcMain.removeHandler('ephemeralVm:attachWorkspace')
  ipcMain.handle('ephemeralVm:attachWorkspace', (_event, args) => host.attachWorkspace(args))
  ipcMain.removeHandler('ephemeralVm:cleanup')
  ipcMain.handle('ephemeralVm:cleanup', (_event, args) => host.cleanup(args))
  ipcMain.removeHandler('ephemeralVm:stopCleanup')
  ipcMain.handle('ephemeralVm:stopCleanup', (_event, args) => host.stopCleanup(args))
  ipcMain.removeHandler('ephemeralVm:suspendWorkspace')
  ipcMain.handle('ephemeralVm:suspendWorkspace', (_event, args) => host.suspendWorkspace(args))
  ipcMain.removeHandler('ephemeralVm:resumeWorkspace')
  ipcMain.handle('ephemeralVm:resumeWorkspace', (_event, args) => host.resumeWorkspace(args))
  ipcMain.removeHandler('ephemeralVm:getCleanupCommand')
  ipcMain.handle('ephemeralVm:getCleanupCommand', (_event, args) => host.getCleanupCommand(args))
}
