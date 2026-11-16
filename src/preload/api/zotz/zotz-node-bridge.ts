import { ipcRenderer } from 'electron'
import type { ZotzNodeSetupStep } from '../../../shared/zotz/zotz-node-setup-contract'
import type { PreloadApi } from '../../api-types'

export const zotzNodeApi = {
  getTailscaleStatus: () => ipcRenderer.invoke('zotzNode:getTailscaleStatus'),
  runServerSetup: () => ipcRenderer.invoke('zotzNode:runServerSetup'),
  onSetupProgress: (callback: (steps: ZotzNodeSetupStep[]) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, steps: ZotzNodeSetupStep[]): void =>
      callback(steps)
    ipcRenderer.on('zotzNode:setupProgress', listener)
    return () => ipcRenderer.removeListener('zotzNode:setupProgress', listener)
  },
  removeAutostart: () => ipcRenderer.invoke('zotzNode:removeAutostart')
} satisfies PreloadApi['zotzNode']
