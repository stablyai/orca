import { randomUUID } from 'node:crypto'

import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import type {
  SessionTabCloseRequest,
  SessionTabCloseResponse,
  SessionTabCloseResult,
  TerminalTabCloseRequest
} from '../../shared/renderer-tab-close'

const TAB_CLOSE_TIMEOUT_MS = 20_000

type TabCloseResponse = { requestId: string; error?: string }

function requestTabCloseFromRenderer(args: {
  mainWindow: BrowserWindow
  requestChannel: string
  responseChannel: string
  request: TerminalTabCloseRequest | SessionTabCloseRequest
  timeoutError: string
}): Promise<TabCloseResponse> {
  const { mainWindow } = args
  if (mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
    return Promise.reject(new Error('renderer_unavailable'))
  }
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timeout)
      ipcMain.removeListener(args.responseChannel, onResponse)
    }
    const onResponse = (event: Electron.IpcMainEvent, response: TabCloseResponse): void => {
      // Why: request IDs are renderer-visible; only the selected window may settle its lifecycle transaction.
      if (
        event.sender !== mainWindow.webContents ||
        response.requestId !== args.request.requestId
      ) {
        return
      }
      cleanup()
      if (response.error) {
        reject(new Error(response.error))
      } else {
        resolve(response)
      }
    }
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(args.timeoutError))
    }, TAB_CLOSE_TIMEOUT_MS)
    ipcMain.on(args.responseChannel, onResponse)
    mainWindow.webContents.send(args.requestChannel, args.request)
  })
}

export async function requestTerminalTabCloseFromRenderer(
  mainWindow: BrowserWindow,
  tabId: string
): Promise<void> {
  await requestTabCloseFromRenderer({
    mainWindow,
    requestChannel: 'ui:terminalTabCloseRequest',
    responseChannel: 'ui:terminalTabCloseResponse',
    request: { requestId: randomUUID(), tabId },
    timeoutError: 'terminal_tab_close_timeout'
  })
}

export async function requestSessionTabCloseFromRenderer(
  mainWindow: BrowserWindow,
  tabId: string,
  worktreeId: string
): Promise<SessionTabCloseResult> {
  const response = (await requestTabCloseFromRenderer({
    mainWindow,
    requestChannel: 'ui:sessionTabCloseRequest',
    responseChannel: 'ui:sessionTabCloseResponse',
    request: { requestId: randomUUID(), tabId, worktreeId },
    timeoutError: 'session_tab_close_timeout'
  })) as SessionTabCloseResponse
  if (!response.result) {
    throw new Error('session_tab_close_failed')
  }
  return response.result
}
