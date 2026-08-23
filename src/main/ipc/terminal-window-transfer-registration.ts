import { ipcMain, type IpcMainEvent } from 'electron'
import type { TerminalWindowTransferCoordinatorOptions } from './terminal-window-transfer-coordinator-options'
import { TerminalWindowTransferCoordinator } from './terminal-window-transfer'

export function registerTerminalWindowTransferHandlers(
  options: TerminalWindowTransferCoordinatorOptions
): TerminalWindowTransferCoordinator {
  const coordinator = new TerminalWindowTransferCoordinator(options)
  ipcMain.removeHandler('terminalWindow:detach')
  ipcMain.removeHandler('terminalWindow:getContext')
  ipcMain.removeAllListeners('terminalWindow:ack')
  ipcMain.handle('terminalWindow:detach', (event, seed) => coordinator.detach(event, seed))
  ipcMain.handle('terminalWindow:getContext', (event) => coordinator.getContext(event))
  ipcMain.on('terminalWindow:ack', (event: IpcMainEvent, ack: unknown) => {
    coordinator.acknowledge(event, ack)
  })
  return coordinator
}
