import { ipcRenderer } from 'electron'
import type { ComputerAwakeStatus } from '../../shared/computer-awake-mode'
import type { PreloadApi } from '../api-types'

export const agentAwakeApi = {
  getStatus: (): Promise<ComputerAwakeStatus> => ipcRenderer.invoke('agentAwake:getStatus'),
  onChanged: (callback: (status: ComputerAwakeStatus) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: ComputerAwakeStatus): void =>
      callback(status)
    ipcRenderer.on('agentAwake:changed', listener)
    return () => ipcRenderer.removeListener('agentAwake:changed', listener)
  }
} satisfies PreloadApi['agentAwake']
