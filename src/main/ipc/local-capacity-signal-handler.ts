import { ipcMain } from 'electron'
import { readLocalCapacitySignal } from '../system/local-capacity-signal'

export function registerLocalCapacitySignalHandler(): void {
  ipcMain.removeHandler('system:getLocalCapacitySignal')
  ipcMain.handle('system:getLocalCapacitySignal', () => readLocalCapacitySignal())
}
