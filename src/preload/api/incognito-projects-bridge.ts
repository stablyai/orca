import { ipcRenderer } from 'electron'
import type { IncognitoLockState } from '../../shared/incognito-projects'
import type { PreloadApi } from '../api-types'

export const incognitoProjectsApi = {
  getState: () => ipcRenderer.invoke('incognito:getState'),
  unlockWithTouchId: () => ipcRenderer.invoke('incognito:unlockWithTouchId'),
  unlockWithPasscode: (args: { passcode: string }) =>
    ipcRenderer.invoke('incognito:unlockWithPasscode', args),
  setPasscode: (args: { passcode: string }) => ipcRenderer.invoke('incognito:setPasscode', args),
  lock: () => ipcRenderer.invoke('incognito:lock'),
  setAllowScreenCapture: (args: { allow: boolean }) =>
    ipcRenderer.invoke('incognito:setAllowScreenCapture', args),
  onStateChanged: (callback: (state: IncognitoLockState) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: IncognitoLockState): void =>
      callback(state)
    ipcRenderer.on('incognito:stateChanged', listener)
    return () => {
      ipcRenderer.removeListener('incognito:stateChanged', listener)
    }
  }
} satisfies PreloadApi['incognitoProjects']
