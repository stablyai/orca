import { randomUUID } from 'node:crypto'
import { ipcMain } from 'electron'
import {
  EXTERNAL_EDITOR_RENDERER_UNAVAILABLE,
  type ExternalEditorRequest,
  type ExternalEditorResponse,
  type ExternalEditorResult
} from '../../shared/external-editor'
import { authorizeExternalEditorFile } from './external-editor-file'

type EditorRenderer = {
  isDestroyed(): boolean
  send(channel: string, ...args: unknown[]): void
  once(event: string, listener: () => void): unknown
  removeListener(event: string, listener: () => void): unknown
}

type EditorWindow = {
  isDestroyed(): boolean
  once(event: 'closed', listener: () => void): unknown
  removeListener(event: 'closed', listener: () => void): unknown
  webContents: EditorRenderer
}

/** Treat renderer loss as failure to protect callers waiting for saved content. */
export async function requestExternalEditor(
  mainWindow: EditorWindow,
  filePath: string,
  wait: boolean,
  signal?: AbortSignal
): Promise<ExternalEditorResult> {
  if (signal?.aborted) {
    throw new Error('Editor request cancelled.')
  }
  const canonicalPath = await authorizeExternalEditorFile(filePath)
  if (signal?.aborted) {
    throw new Error('Editor request cancelled.')
  }
  if (mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
    throw new Error(EXTERNAL_EDITOR_RENDERER_UNAVAILABLE)
  }
  const webContents = mainWindow.webContents
  const requestId = randomUUID()
  return new Promise((resolve, reject) => {
    let settled = false
    let opened = false
    /** Renderer loss, abort, and acknowledgement can race to settle the same request. */
    const finish = (error?: Error): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      ipcMain.removeListener('ui:externalEditorResponse', onResponse)
      mainWindow.removeListener('closed', unavailable)
      webContents.removeListener('destroyed', unavailable)
      webContents.removeListener('render-process-gone', unavailable)
      webContents.removeListener('did-start-loading', unavailable)
      signal?.removeEventListener('abort', aborted)
      try {
        if (!webContents.isDestroyed()) {
          webContents.send('ui:externalEditorCancel', requestId)
        }
      } catch {
        // Renderer loss still settles the CLI even if cancellation cannot be delivered.
      }
      if (error) {
        reject(error)
      } else {
        resolve({ filePath: canonicalPath, closed: wait })
      }
    }
    const unavailable = (): void => finish(new Error(EXTERNAL_EDITOR_RENDERER_UNAVAILABLE))
    const aborted = (): void => finish(new Error('Editor request cancelled.'))
    /** Only the opening renderer can acknowledge this caller’s edit session. */
    const onResponse = (event: Electron.IpcMainEvent, response: ExternalEditorResponse): void => {
      if (event.sender !== webContents || response?.requestId !== requestId) {
        return
      }
      if (response.status === 'error') {
        finish(new Error(response.error || 'Editor request failed.'))
      } else if (response.status === 'opened') {
        opened = true
        clearTimeout(timeout)
        if (!wait) {
          finish()
        }
      } else if (response.status === 'closed' && opened) {
        finish()
      }
    }
    // An older renderer must fail explicitly instead of leaving a caller waiting forever.
    const timeout = setTimeout(
      () => finish(new Error('The editor did not acknowledge the file.')),
      30_000
    )
    timeout.unref?.()
    ipcMain.on('ui:externalEditorResponse', onResponse)
    mainWindow.once('closed', unavailable)
    webContents.once('destroyed', unavailable)
    webContents.once('render-process-gone', unavailable)
    webContents.once('did-start-loading', unavailable)
    signal?.addEventListener('abort', aborted, { once: true })
    const request: ExternalEditorRequest = { requestId, filePath: canonicalPath, wait }
    try {
      webContents.send('ui:externalEditorRequest', request)
    } catch {
      unavailable()
    }
  })
}
