import type { ContextBridge, IpcRenderer } from 'electron'
import {
  BROWSER_PASSKEY_REQUEST_CANCEL_CHANNEL,
  BROWSER_PASSKEY_REQUEST_PENDING_CHANNEL
} from '../shared/browser-passkey-request'
import { installBrowserPasskeyRequestWatch } from './browser-passkey-request-watch'

// A session preload: it runs in every frame of every browser page, popup and serve window.
const electron: {
  contextBridge: ContextBridge
  ipcRenderer: Pick<IpcRenderer, 'send' | 'on'>
} = require('electron')
const { contextBridge, ipcRenderer } = electron

const cancel: unknown = contextBridge.executeInMainWorld({
  func: installBrowserPasskeyRequestWatch,
  args: [(pending: boolean) => ipcRenderer.send(BROWSER_PASSKEY_REQUEST_PENDING_CHANNEL, pending)]
})
ipcRenderer.on(BROWSER_PASSKEY_REQUEST_CANCEL_CHANNEL, () => {
  if (typeof cancel === 'function') {
    cancel()
  }
})
