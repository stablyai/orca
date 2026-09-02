import { ipcRenderer } from 'electron'
import type {
  TerminalPreviewConnectResult,
  TerminalPreviewDataPayload
} from '../../shared/terminal-preview'
import type { PreloadApi } from '../api-types'

export const terminalPreviewApi = {
  connect: (
    ptyId: string,
    opts?: { scrollbackRows?: number }
  ): Promise<TerminalPreviewConnectResult> =>
    ipcRenderer.invoke('terminalPreview:connect', { ptyId, opts }),
  input: (ptyId: string, data: string): Promise<boolean> =>
    ipcRenderer.invoke('terminalPreview:input', { ptyId, data }),
  fit: (
    ptyId: string,
    cols: number,
    rows: number
  ): Promise<{ cols: number; rows: number } | null> =>
    ipcRenderer.invoke('terminalPreview:fit', { ptyId, cols, rows }),
  ack: (ptyId: string, bytes: number): Promise<void> =>
    ipcRenderer.invoke('terminalPreview:ack', { ptyId, bytes }),
  unsubscribe: (ptyId: string): Promise<void> =>
    ipcRenderer.invoke('terminalPreview:unsubscribe', { ptyId }),
  onData: (callback: (payload: TerminalPreviewDataPayload) => void): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: TerminalPreviewDataPayload
    ): void => callback(payload)
    ipcRenderer.on('terminalPreview:data', listener)
    return () => ipcRenderer.removeListener('terminalPreview:data', listener)
  }
} satisfies PreloadApi['terminalPreview']
