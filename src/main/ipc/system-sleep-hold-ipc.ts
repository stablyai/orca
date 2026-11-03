import { ipcMain } from 'electron'
import {
  createSystemSleepHoldReader,
  type SystemSleepHoldReader
} from '../macos-sleep-disabled-setting'

export function registerSystemSleepHoldHandler(
  reader: SystemSleepHoldReader = createSystemSleepHoldReader()
): void {
  ipcMain.handle('agentAwake:getSystemSleepHold', () => reader.read())
}
