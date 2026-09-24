// IPC facade for editor language-server navigation (spec §4): semantic
// payloads only — no LSP message crosses the renderer boundary. These are
// Electron-local channels (main and renderer ship atomically), so the
// remote-wire compatibility rules do not apply here.
import { BrowserWindow, ipcMain } from 'electron'
import {
  getLanguageServerHost,
  type LanguageServerHost
} from '../language-servers/language-server-host'
import { hasAppEnvironment, getAppEnvironment } from '../../shared/app-environment'
import {
  LANGUAGE_SERVERS_STATUS_CHANNEL,
  type LanguageServerDocumentChange,
  type LanguageServerDocumentResult,
  type LanguageServerDefinitionResult,
  type LanguageServerHoverResult,
  type LanguageServerPosition,
  type LanguageServerStatusEvent
} from '../../shared/language-server-navigation-types'

function broadcastStatus(event: LanguageServerStatusEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) {
      continue
    }
    try {
      window.webContents.send(LANGUAGE_SERVERS_STATUS_CHANNEL, event)
    } catch {
      // A renderer can disappear between isDestroyed() and send().
    }
  }
}

export function registerLanguageServersHandlers(
  host: LanguageServerHost = getLanguageServerHost({
    onStatus: (text) => broadcastStatus({ kind: 'progress', text }),
    onToast: (message) => broadcastStatus({ kind: 'toast', message }),
    onDegraded: (message) => broadcastStatus({ kind: 'degraded', message })
  })
): void {
  for (const channel of [
    'languageServers:openDocument',
    'languageServers:changeDocument',
    'languageServers:closeDocument',
    'languageServers:definition',
    'languageServers:hover'
  ] as const) {
    ipcMain.removeHandler(channel)
  }

  ipcMain.handle(
    'languageServers:openDocument',
    async (
      _event,
      args: { worktreeRoot: string; filePath: string; text: string }
    ): Promise<LanguageServerDocumentResult> => {
      const result = await host.openDocument(args)
      if (!result.ok) {
        console.warn('[language-servers] openDocument failed:', result.error)
      }
      return result
    }
  )

  ipcMain.handle(
    'languageServers:changeDocument',
    (
      _event,
      args: {
        filePath: string
        version: number
        changes: readonly LanguageServerDocumentChange[]
      }
    ): LanguageServerDocumentResult => host.changeDocument(args)
  )

  ipcMain.handle(
    'languageServers:closeDocument',
    (_event, args: { filePath: string }): LanguageServerDocumentResult => host.closeDocument(args)
  )

  ipcMain.handle(
    'languageServers:definition',
    async (
      _event,
      args: { filePath: string; position: LanguageServerPosition }
    ): Promise<LanguageServerDefinitionResult> => {
      try {
        return { ok: true, locations: await host.definition(args) }
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          locations: []
        }
      }
    }
  )

  ipcMain.handle(
    'languageServers:hover',
    async (
      _event,
      args: { filePath: string; position: LanguageServerPosition }
    ): Promise<LanguageServerHoverResult> => {
      try {
        return { ok: true, hover: await host.hover(args) }
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          hover: null
        }
      }
    }
  )

  if (hasAppEnvironment()) {
    getAppEnvironment().onWillQuit(() => {
      void host.shutdownAll()
    })
  }
}
