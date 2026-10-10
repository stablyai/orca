import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'
import type { KernelFrameEvent } from '../../shared/notebook-kernel-types'

export const notebookApi = {
  listPythonEnvironments: (args) => ipcRenderer.invoke('notebook:listPythonEnvironments', args),
  describePython: (args) => ipcRenderer.invoke('notebook:describePython', args),
  startKernel: (args) => ipcRenderer.invoke('notebook:startKernel', args),
  installIpykernel: (args) => ipcRenderer.invoke('notebook:installIpykernel', args),
  createVenv: (args) => ipcRenderer.invoke('notebook:createVenv', args),
  execute: (args) => ipcRenderer.invoke('notebook:execute', args),
  interrupt: (args) => ipcRenderer.invoke('notebook:interrupt', args),
  shutdownKernel: (args) => ipcRenderer.invoke('notebook:shutdownKernel', args),
  onKernelFrame: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: KernelFrameEvent) =>
      callback(payload)
    ipcRenderer.on('notebook:kernelFrame', listener)
    return () => ipcRenderer.removeListener('notebook:kernelFrame', listener)
  }
} satisfies PreloadApi['notebook']
