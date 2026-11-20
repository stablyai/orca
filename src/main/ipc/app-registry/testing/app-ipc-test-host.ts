import { beforeEach } from 'vitest'
import * as electron from 'electron'
import type { AppCaller } from '../../../../shared/app-ipc/app-caller'
import { setAppIpcHost, type AppDocument, type AppHandler } from '../app-handler-registry'

// Keep existing family fixtures at the transport boundary while dispatching plain callers.
beforeEach(() => {
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
      const sender =
        target !== 'all' && 'documentId' in target
          ? sources.get(target.documentId)
          : target !== 'all' && 'sourceId' in target
            ? [...sources.values()].find((source) => source.id === target.sourceId)
            : undefined
      sender?.send(channel, ...(payload === undefined ? [] : [payload]))
    },
    isCurrent: (caller) => !sources.get(caller.documentId)?.isDestroyed?.(),
    flushDocumentStorage: (caller) => {
      sources.get(caller.documentId)?.session.flushStorageData()
    }
  })
})
