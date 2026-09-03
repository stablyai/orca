import { ipcRenderer } from 'electron'
import type { PtyModelRestoreNeededEvent } from '../../shared/pty-model-restore-marker'
import type { TerminalSideEffectBatch } from '../../shared/terminal-side-effect-facts'
import type { PreloadApi } from '../api-types'
import type { TerminalProcessInspection } from '../../shared/terminal-process-inspection'

export const ptyStreamAndSerializationApi = {
  inspectProcess: (
    id: string,
    options?: { expectedIncarnationId?: string }
  ): Promise<TerminalProcessInspection> =>
    ipcRenderer.invoke('pty:inspectProcess', { id, ...options }),
  confirmForegroundProcess: (id: string): Promise<string | null> =>
    ipcRenderer.invoke('pty:confirmForegroundProcess', { id }),
  getCwd: (id: string): Promise<string> => ipcRenderer.invoke('pty:getCwd', { id }),
  getSize: (id: string): Promise<{ cols: number; rows: number } | null> =>
    ipcRenderer.invoke('pty:getSize', { id }),
  onData: (
    callback: (data: {
      id: string
      data: string
      seq?: number
      rawLength?: number
      transformed?: boolean
      background?: boolean
      droppedOutput?: boolean
    }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: {
        id: string
        data: string
        seq?: number
        rawLength?: number
        transformed?: boolean
        background?: boolean
        droppedOutput?: boolean
      }
    ) => callback(data)
    ipcRenderer.on('pty:data', listener)
    return () => ipcRenderer.removeListener('pty:data', listener)
  },
  onReplay: (callback: (data: { id: string; data: string }) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: { id: string; data: string }) =>
      callback(data)
    ipcRenderer.on('pty:replay', listener)
    return () => ipcRenderer.removeListener('pty:replay', listener)
  },
  onModelRestoreNeeded: (callback: (event: PtyModelRestoreNeededEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, event: PtyModelRestoreNeededEvent) =>
      callback(event)
    ipcRenderer.on('pty:modelRestoreNeeded', listener)
    return () => ipcRenderer.removeListener('pty:modelRestoreNeeded', listener)
  },
  onSideEffect: (callback: (batch: TerminalSideEffectBatch) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, batch: TerminalSideEffectBatch) =>
      callback(batch)
    ipcRenderer.on('pty:sideEffect', listener)
    return () => ipcRenderer.removeListener('pty:sideEffect', listener)
  },
  getSideEffectSnapshot: (id: string): Promise<TerminalSideEffectBatch | null> =>
    ipcRenderer.invoke('pty:sideEffectSnapshot', { id }),
  onExit: (
    callback: (data: {
      id: string
      code: number
      preserveRendererBinding?: boolean
      /** Which lifetime of `id` died; absent when the execution host predates the field. */
      incarnationId?: string
      /** Set only when the owning relay disowned this id; never a claim that the process died. */
      ptySourceDisowned?: true
    }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: {
        id: string
        code: number
        preserveRendererBinding?: boolean
        incarnationId?: string
        ptySourceDisowned?: true
      }
    ) => callback(data)
    ipcRenderer.on('pty:exit', listener)
    return () => ipcRenderer.removeListener('pty:exit', listener)
  },
  onSpawned: (callback: (data: { id: string }) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: { id: string }) => callback(data)
    ipcRenderer.on('pty:spawned', listener)
    return () => ipcRenderer.removeListener('pty:spawned', listener)
  },
  onSerializeBufferRequest: (
    callback: (data: {
      requestId: string
      ptyId: string
      opts?: { scrollbackRows?: number }
    }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: {
        requestId: string
        ptyId: string
        opts?: { scrollbackRows?: number }
      }
    ) => callback(data)
    ipcRenderer.on('pty:serializeBuffer:request', listener)
    return () => ipcRenderer.removeListener('pty:serializeBuffer:request', listener)
  },
  onClearBufferRequest: (callback: (data: { ptyId: string }) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: { ptyId: string }) => callback(data)
    ipcRenderer.on('pty:clearBuffer:request', listener)
    return () => ipcRenderer.removeListener('pty:clearBuffer:request', listener)
  },
  sendSerializedBuffer: (
    requestId: string,
    snapshot: {
      data: string
      cols: number
      rows: number
      seq?: number
      lastTitle?: string
      kittyKeyboardFlags?: number
    } | null
  ): void => {
    ipcRenderer.send('pty:serializeBuffer:response', { requestId, snapshot })
  },
  declarePendingPaneSerializer: (paneKey: string): Promise<number> =>
    ipcRenderer.invoke('pty:declarePendingPaneSerializer', { paneKey }),
  settlePaneSerializer: (paneKey: string, gen: number): Promise<void> =>
    ipcRenderer.invoke('pty:settlePaneSerializer', { paneKey, gen }),
  clearPendingPaneSerializer: (paneKey: string, gen: number): Promise<void> =>
    ipcRenderer.invoke('pty:clearPendingPaneSerializer', { paneKey, gen }),
  reportRendererSerializerReady: (ptyId: string): Promise<void> =>
    ipcRenderer.invoke('pty:reportRendererSerializerReady', { ptyId }),
  management: {
    listSessions: () => ipcRenderer.invoke('pty:management:listSessions'),
    killAll: () => ipcRenderer.invoke('pty:management:killAll'),
    killOne: (args: { sessionId: string }) => ipcRenderer.invoke('pty:management:killOne', args),
    restart: () => ipcRenderer.invoke('pty:management:restart'),
    macTccAttribution: () => ipcRenderer.invoke('pty:management:macTccAttribution')
  }
} satisfies Partial<PreloadApi['pty']>
