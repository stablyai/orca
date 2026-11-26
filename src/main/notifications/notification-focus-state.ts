import { isMacosFocusActive } from './macos-focus-state'
import { isWindowsFocusAssistActive } from './windows-focus-state'

export async function isNotificationFocusActive(): Promise<boolean> {
  if (process.platform === 'darwin') {
    return isMacosFocusActive()
  }
  if (process.platform === 'win32') {
    return isWindowsFocusAssistActive()
  }
  return false
}
