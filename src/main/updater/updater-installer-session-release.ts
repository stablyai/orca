import { BrowserWindow } from 'electron'
import { killAllPty } from '../ipc/pty/kill-all'

/** Past the install commit: end local PTYs and let windows close without their close guards. */
export function releaseSessionsForInstaller(): number {
  killAllPty()
  const windows = BrowserWindow.getAllWindows()
  for (const win of windows) {
    win.removeAllListeners('close')
  }
  return windows.length
}
