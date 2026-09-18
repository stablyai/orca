import { ipcRenderer } from 'electron'
import type {
  TerminalPreviewConnectOptions,
  TerminalPreviewConnectResult,
  TerminalPreviewDataPayload
} from '../../shared/terminal-preview'
import type { PreloadApi } from '../api-types'

export const terminalPreviewApi = {
  connect: (
    ptyId: string,
    opts?: TerminalPreviewConnectOptions
  ): Promise<TerminalPreviewConnectResult> =>
    ipcRenderer.invoke('terminalPreview:connect', {
      ptyId,
      opts: { scrollbackRows: opts?.scrollbackRows },
      surfaceId: opts?.surfaceId
    }),
  input: (ptyId: string, data: string): Promise<boolean> =>
    ipcRenderer.invoke('terminalPreview:input', { ptyId, data }),
  fit: (
    ptyId: string,
    cols: number,
    rows: number,
    surfaceId?: string
  ): Promise<{ cols: number; rows: number } | null> =>
    ipcRenderer.invoke('terminalPreview:fit', { ptyId, cols, rows, surfaceId }),
  ack: (ptyId: string, bytes: number, surfaceId?: string): Promise<void> =>
    ipcRenderer.invoke('terminalPreview:ack', { ptyId, bytes, surfaceId }),
  unsubscribe: (ptyId: string, surfaceId?: string): Promise<void> =>
    ipcRenderer.invoke('terminalPreview:unsubscribe', { ptyId, surfaceId }),
  detach: (ptyIds: string[], surfaceId?: string): Promise<void> =>
    ipcRenderer.invoke('terminalPreview:detach', { ptyIds, surfaceId }),
  onData: (callback: (payload: TerminalPreviewDataPayload) => void): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: TerminalPreviewDataPayload
    ): void => callback(payload)
    ipcRenderer.on('terminalPreview:data', listener)
    return () => ipcRenderer.removeListener('terminalPreview:data', listener)
  }
} satisfies PreloadApi['terminalPreview']
