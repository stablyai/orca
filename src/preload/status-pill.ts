import { contextBridge, ipcRenderer } from 'electron'
import type {
  StatusPillAgentRow,
  StatusPillAnswerResult,
  StatusPillFocusTarget,
  StatusPillPreferences,
  StatusPillPreloadApi,
  StatusPillSummary
} from '../shared/status-pill-preload-api'

const api: StatusPillPreloadApi = {
  onSnapshot: (callback: (summary: StatusPillSummary) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, summary: StatusPillSummary): void => {
      callback(summary)
    }
    ipcRenderer.on('statusPill:snapshot', listener)
    return () => {
      ipcRenderer.removeListener('statusPill:snapshot', listener)
    }
  },
  onAgentRows: (callback: (rows: StatusPillAgentRow[]) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, rows: StatusPillAgentRow[]): void => {
      callback(rows)
    }
    ipcRenderer.on('statusPill:agentRows', listener)
    return () => {
      ipcRenderer.removeListener('statusPill:agentRows', listener)
    }
  },
  onAttentionPulse: (callback: () => void): (() => void) => {
    const listener = (): void => {
      callback()
    }
    ipcRenderer.on('statusPill:attentionPulse', listener)
    return () => {
      ipcRenderer.removeListener('statusPill:attentionPulse', listener)
    }
  },
  getSnapshot: (): Promise<StatusPillSummary> => ipcRenderer.invoke('statusPill:getSnapshot'),
  getAgentRows: (): Promise<StatusPillAgentRow[]> => ipcRenderer.invoke('statusPill:getAgentRows'),
  fireClick: (): void => {
    ipcRenderer.send('statusPill:click')
  },
  fireContextMenu: (): void => {
    ipcRenderer.send('statusPill:contextMenu')
  },
  focusPane: (target: StatusPillFocusTarget): void => {
    ipcRenderer.send('statusPill:focusPane', target)
  },
  getInitialPreferences: (): Promise<StatusPillPreferences> =>
    ipcRenderer.invoke('statusPill:getInitialPreferences'),
  getWindowPosition: (): Promise<{ x: number; y: number }> =>
    ipcRenderer.invoke('statusPill:getWindowPosition'),
  setWindowPosition: (position: { x: number; y: number }): void => {
    ipcRenderer.send('statusPill:setWindowPosition', position)
  },
  resize: (width: number, height: number): void => {
    ipcRenderer.send('statusPill:resize', { width, height })
  },
  answerQuestion: (paneKey: string, raw: string): Promise<StatusPillAnswerResult> =>
    ipcRenderer.invoke('statusPill:answerAgent', { paneKey, raw })
}

// Why: the status-pill renderer is the only surface this preload bridges, so
// expose the typed api directly under `api` (matching the main window's
// `window.api` shape, which the React code reads via `window.api`).
try {
  contextBridge.exposeInMainWorld('api', api)
} catch (error) {
  console.error('[status-pill-preload] failed to expose api', error)
}
