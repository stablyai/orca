import { ipcRenderer } from 'electron'
import type { CodexMicroConnectionState, CodexMicroInputEvent } from '../../shared/codex-micro-types'
import type { PreloadApi } from '../api-types'

export const codexMicroApi = {
  getState: (): Promise<CodexMicroConnectionState> => ipcRenderer.invoke('codexMicro:getState'),
  subscribeState: (callback: (state: CodexMicroConnectionState) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: CodexMicroConnectionState): void =>
      callback(state)
    ipcRenderer.on('codexMicro:state', listener)
    return () => ipcRenderer.removeListener('codexMicro:state', listener)
  },
  subscribeInput: (callback: (event: CodexMicroInputEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, input: CodexMicroInputEvent): void =>
      callback(input)
    ipcRenderer.on('codexMicro:input', listener)
    return () => ipcRenderer.removeListener('codexMicro:input', listener)
  },
  setOutputSnapshot: (args: {
    rgbcfg: Record<string, unknown>
    thstatus: unknown[]
  }): Promise<void> => ipcRenderer.invoke('codexMicro:setOutputSnapshot', args),
  retry: (): Promise<void> => ipcRenderer.invoke('codexMicro:retry'),
  release: (): Promise<void> => ipcRenderer.invoke('codexMicro:release')
} satisfies PreloadApi['codexMicro']
