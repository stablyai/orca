import { beforeEach } from 'vitest'
import * as electron from 'electron'
import type { AppCaller } from '../../../../shared/app-ipc/app-caller'
import { setAppIpcHost, type AppDocument, type AppHandler } from '../app-handler-registry'

type FixtureWindow = {
  id: number
  isDestroyed(): boolean
  webContents: Pick<Electron.WebContents, 'id' | 'send'>
}
const fixtureWindows = new Map<number, FixtureWindow>()

export function registerAppFixtureWindow(window: FixtureWindow): void {
  fixtureWindows.set(window.id, window)
}

// Keep existing family fixtures at the transport boundary while dispatching plain callers.
beforeEach(() => {
  fixtureWindows.clear()
  const sources = new Map<string, Electron.WebContents>()
  const documents = new Map<string, AppDocument>()
  const callerFor = (event: Electron.IpcMainInvokeEvent): AppCaller => {
    const sender = event?.sender
    const documentId = String(sender?.id ?? 'fixture')
    if (sender) {
      sources.set(documentId, sender)
    }
    return {
      documentId,
      role: 'main',
      isMainFrame: !event?.senderFrame || event.senderFrame === sender?.mainFrame,
      windowId:
        sender && 'BrowserWindow' in electron
          ? (electron.BrowserWindow.fromWebContents?.(sender)?.id ?? null)
          : null
    }
  }
  const listenerFor =
    (handler: AppHandler) =>
    (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) =>
      handler(callerFor(event), ...args)
  setAppIpcHost({
    handle: (channel, handler) => electron.ipcMain.handle(channel, listenerFor(handler)),
    on: (channel, handler) => electron.ipcMain.on(channel, listenerFor(handler)),
    removeHandler: (channel) => electron.ipcMain.removeHandler(channel),
    removeAllListeners: (channel) => {
      electron.ipcMain.removeAllListeners(channel)
    },
    window: (caller) => {
      const source = sources.get(caller.documentId)
      if (!source) {
        throw new Error('Missing fixture window')
      }
      return {
        id: source.id,
        isDestroyed: () => source.isDestroyed?.() ?? false,
        on: source.on?.bind(source),
        once: source.once?.bind(source),
        removeListener: source.removeListener?.bind(source)
      }
    },
    isRegisteredMain: () => true,
    document: (caller) => {
      let document = documents.get(caller.documentId)
      if (!document) {
        const source = sources.get(caller.documentId)
        if (!source) {
          throw new Error('Missing fixture document')
        }
        document = {
          id: source.id,
          caller,
          isDestroyed: () => source.isDestroyed?.() ?? false,
          on: source.on?.bind(source),
          once: source.once?.bind(source),
          removeListener: source.removeListener?.bind(source)
        }
        documents.set(caller.documentId, document)
      }
      return document
    },
    publish: (channel, payload, target) => {
      const args = payload === undefined ? [] : [payload]
      if (target !== 'all' && 'documentId' in target) {
        sources.get(target.documentId)?.send(channel, ...args)
        return
      }
      const windows = [
        ...fixtureWindows.values(),
        ...(fixtureWindows.size === 0 && 'BrowserWindow' in electron
          ? (electron.BrowserWindow.getAllWindows?.() ?? [])
          : [])
      ]
      const deliveries = [
        ...sources.values(),
        ...windows.filter((window) => !window.isDestroyed()).map((window) => window.webContents)
      ]
      for (const source of new Set(deliveries)) {
        if (
          target === 'all' ||
          ('sourceId' in target && source.id === target.sourceId) ||
          ('windowId' in target &&
            windows.some(
              (window) => window.id === target.windowId && window.webContents === source
            ))
        ) {
          source.send(channel, ...args)
        }
      }
    },
    isCurrent: (caller) => {
      const source = sources.get(caller.documentId)
      return source !== undefined && !source.isDestroyed?.()
    },
    flushDocumentStorage: (caller) => {
      sources.get(caller.documentId)?.session.flushStorageData()
    }
  })
})
