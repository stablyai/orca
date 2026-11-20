import { EventEmitter } from 'node:events'
import {
  BrowserWindow,
  ipcMain,
  webContents,
  type IpcMainInvokeEvent,
  type WebContents
} from 'electron'
import type { AppDocumentRole } from '../../../shared/app-ipc/app-caller'
import {
  setAppIpcHost,
  type AppCaller,
  type AppDocument,
  type AppHandler,
  type AppIpcHost
} from './app-handler-registry'

type Document = {
  sender: WebContents
  frame: WebContents['mainFrame']
  events: EventEmitter
  document: AppDocument
}

export function createElectronAppIpcHost(
  roleFor: (sender: WebContents) => AppDocumentRole
): AppIpcHost {
  const documents = new Map<string, Document>()
  const current = new WeakMap<WebContents, Document>()
  const callers = new WeakMap<AppCaller, AppDocument>()
  const observed = new WeakSet<WebContents>()
  let nextDocumentId = 1

  const retire = (sender: WebContents, event: string): void => {
    const owned = current.get(sender)
    if (!owned) {
      return
    }
    current.delete(sender)
    documents.delete(owned.document.caller.documentId)
    owned.events.emit(event)
    if (event !== 'destroyed') {
      owned.events.emit('destroyed')
    }
    owned.events.removeAllListeners()
  }
  const documentFor = (sender: WebContents): Document => {
    const existing = current.get(sender)
    if (existing && existing.frame === sender.mainFrame) {
      return existing
    }
    retire(sender, 'did-navigate')
    if (!observed.has(sender)) {
      observed.add(sender)
      sender.on('did-navigate', () => retire(sender, 'did-navigate'))
      sender.on('render-process-gone', () => retire(sender, 'render-process-gone'))
      sender.once('destroyed', () => retire(sender, 'destroyed'))
    }
    const events = new EventEmitter()
    const caller: AppCaller = Object.freeze({
      documentId: `${sender.id}:${nextDocumentId++}`,
      role: roleFor(sender),
      isMainFrame: true,
      windowId: BrowserWindow.fromWebContents(sender)?.id ?? null
    })
    const document: AppDocument = {
      id: sender.id,
      caller,
      isDestroyed: () => current.get(sender)?.document !== document || sender.isDestroyed(),
      on: (event, listener) => events.on(event, listener),
      once: (event, listener) => events.once(event, listener),
      removeListener: (event, listener) => events.removeListener(event, listener)
    }
    const owned: Document = { sender, frame: sender.mainFrame, events, document }
    current.set(sender, owned)
    documents.set(caller.documentId, owned)
    return owned
  }
  const invoke =
    (listener: AppHandler) =>
    (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      const { sender, senderFrame } = event
      if (
        sender.isDestroyed() ||
        !senderFrame ||
        senderFrame.detached ||
        (senderFrame !== sender.mainFrame && senderFrame.parent === null)
      ) {
        throw new Error('Application IPC document has retired')
      }
      const { caller } = documentFor(sender).document
      const requestCaller: AppCaller = Object.freeze({
        ...caller,
        role: roleFor(sender),
        isMainFrame: senderFrame === sender.mainFrame
      })
      callers.set(requestCaller, documentFor(sender).document)
      return listener(requestCaller, ...args)
    }
  return {
    handle: (channel, listener) => ipcMain.handle(channel, invoke(listener)),
    on: (channel, listener) => ipcMain.on(channel, invoke(listener)),
    removeHandler: (channel) => ipcMain.removeHandler(channel),
    removeAllListeners: (channel) => {
      ipcMain.removeAllListeners(channel)
    },
    document: (caller) => {
      const document = callers.get(caller) ?? documents.get(caller.documentId)?.document
      if (!document) {
        throw new Error('Unknown application IPC document')
      }
      return document
    },
    flushDocumentStorage: (caller) => {
      const owned = documents.get(caller.documentId)
      if (!owned || owned.document.isDestroyed()) {
        throw new Error('Application IPC document has retired')
      }
      owned.sender.session.flushStorageData()
    },
    isCurrent: (caller) => {
      const owned = documents.get(caller.documentId)
      return (
        owned !== undefined &&
        !owned.document.isDestroyed() &&
        owned.frame === owned.sender.mainFrame
      )
    },
    publish: (channel, payload, target) => {
      const args = payload === undefined ? [] : [payload]
      if (target !== 'all' && 'documentId' in target) {
        const owned = documents.get(target.documentId)
        if (owned && !owned.document.isDestroyed() && owned.frame === owned.sender.mainFrame) {
          owned.sender.send(channel, ...args)
        }
        return
      }
      if (target !== 'all') {
        const sender =
          'windowId' in target
            ? BrowserWindow.fromId(target.windowId)?.webContents
            : webContents.fromId(target.sourceId)
        if (sender && !sender.isDestroyed()) {
          sender.send(channel, ...args)
        }
        return
      }
      for (const window of BrowserWindow.getAllWindows()) {
        if (window.isDestroyed() || window.webContents.isDestroyed()) {
          continue
        }
        window.webContents.send(channel, ...args)
      }
    }
  }
}

export function installElectronAppIpc(roleFor: (sender: WebContents) => AppDocumentRole): void {
  setAppIpcHost(createElectronAppIpcHost(roleFor))
}
