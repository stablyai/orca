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
  type AppWindow,
  type AppHandler,
  type AppIpcHost
} from './app-handler-registry'

type Document = {
  sender: WebContents
  frame: WebContents['mainFrame']
  events: EventEmitter
  document: AppDocument
  requestCallers: Map<string, AppCaller>
}

export function createElectronAppIpcHost(
  roleFor: (sender: WebContents) => AppDocumentRole,
  isRegisteredMainFor: (sender: WebContents) => boolean = () => false
): AppIpcHost {
  const documents = new Map<string, Document>()
  const current = new WeakMap<WebContents, Document>()
  const callers = new WeakMap<AppCaller, AppDocument>()
  const observed = new WeakSet<WebContents>()
  const windows = new WeakMap<WebContents, AppWindow>()
  const sources = new WeakMap<AppDocument, WebContents>()
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
  const documentFor = (sender: WebContents, mainFrame = sender.mainFrame): Document => {
    const existing = current.get(sender)
    if (existing && existing.frame === mainFrame) {
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
    const owned: Document = {
      sender,
      frame: mainFrame,
      events,
      document,
      requestCallers: new Map()
    }
    sources.set(document, sender)
    current.set(sender, owned)
    documents.set(caller.documentId, owned)
    return owned
  }
  // Hot path: reuse one frozen caller per document, role and frame kind.
  const requestCallerFor = (
    owned: Document,
    role: AppDocumentRole,
    isMainFrame: boolean
  ): AppCaller => {
    const key = isMainFrame ? role : `${role}:subframe`
    let requestCaller = owned.requestCallers.get(key)
    if (!requestCaller) {
      requestCaller = Object.freeze({ ...owned.document.caller, role, isMainFrame })
      owned.requestCallers.set(key, requestCaller)
      callers.set(requestCaller, owned.document)
    }
    return requestCaller
  }
  const invoke =
    (listener: AppHandler, dropRetired = false) =>
    (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      const { sender, senderFrame } = event
      const mainFrame = sender.isDestroyed() ? undefined : sender.mainFrame
      if (
        !mainFrame ||
        !senderFrame ||
        senderFrame.detached ||
        (senderFrame !== mainFrame && senderFrame.parent === null)
      ) {
        if (dropRetired) {
          return
        }
        throw new Error('Application IPC document has retired')
      }
      const owned = documentFor(sender, mainFrame)
      return listener(requestCallerFor(owned, roleFor(sender), senderFrame === mainFrame), ...args)
    }
  return {
    handle: (channel, listener) => ipcMain.handle(channel, invoke(listener)),
    on: (channel, listener) => ipcMain.on(channel, invoke(listener, true)),
    removeHandler: (channel) => ipcMain.removeHandler(channel),
    removeAllListeners: (channel) => {
      ipcMain.removeAllListeners(channel)
    },
    window: (caller) => {
      const document = callers.get(caller) ?? documents.get(caller.documentId)?.document
      const source = document && sources.get(document)
      if (!source) {
        throw new Error('Application window has closed')
      }
      let window = windows.get(source)
      if (!window) {
        const lifecycle: NodeJS.EventEmitter = source
        window = {
          id: source.id,
          isDestroyed: () => source.isDestroyed(),
          on: (event, listener) => lifecycle.on(event, listener),
          once: (event, listener) => lifecycle.once(event, listener),
          removeListener: (event, listener) => lifecycle.removeListener(event, listener)
        }
        windows.set(source, window)
      }
      return window
    },
    isRegisteredMain: (caller) => {
      const owned = documents.get(caller.documentId)
      return !!owned && !owned.document.isDestroyed() && isRegisteredMainFor(owned.sender)
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
            : target.sourceId === undefined
              ? undefined
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

export function installElectronAppIpc(
  roleFor: (sender: WebContents) => AppDocumentRole,
  isRegisteredMainFor: (sender: WebContents) => boolean = () => false
): void {
  setAppIpcHost(createElectronAppIpcHost(roleFor, isRegisteredMainFor))
}
