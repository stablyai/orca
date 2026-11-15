import type { ContextBridge, IpcRenderer } from 'electron'
import {
  BROWSER_PASSKEY_REQUEST_CANCEL_CHANNEL,
  BROWSER_PASSKEY_REQUEST_PENDING_CHANNEL
} from '../shared/browser-passkey-request'
import {
  BROWSER_AGENT_LEAD_CHANNEL,
  BROWSER_AGENT_LEAD_QUERY_CHANNEL,
  BROWSER_PRINT_REFUSED_CHANNEL
} from '../shared/browser-system-dialogs'
import { installBrowserPasskeyRequestWatch } from './browser/passkeys/browser-passkey-request-watch'
import { installBrowserPrintGuard } from './browser/printing/browser-print-guard'

// A session preload: it runs in every frame of every browser page, popup and serve window.
const electron: {
  contextBridge: ContextBridge
  ipcRenderer: Pick<IpcRenderer, 'send' | 'on'>
} = require('electron')
const { contextBridge, ipcRenderer } = electron

// Pushed by main, since print() must decide synchronously. Unknown until main answers, which
// refuses: an agent-led page's script can print before the answer lands.
let agentLed: boolean | null = null
ipcRenderer.on(BROWSER_AGENT_LEAD_CHANNEL, (_event, led: unknown) => {
  agentLed = led === true
})
ipcRenderer.send(BROWSER_AGENT_LEAD_QUERY_CHANNEL)
// Only Windows hands a passkey request to a system dialog (Windows Hello).
const passkeysOpenSystemDialog = process.platform === 'win32'

const cancel: unknown = contextBridge.executeInMainWorld({
  func: installBrowserPasskeyRequestWatch,
  args: [
    (pending: boolean) => ipcRenderer.send(BROWSER_PASSKEY_REQUEST_PENDING_CHANNEL, pending),
    () => !(passkeysOpenSystemDialog && agentLed !== false)
  ]
})
ipcRenderer.on(BROWSER_PASSKEY_REQUEST_CANCEL_CHANNEL, () => {
  if (typeof cancel === 'function') {
    cancel()
  }
})
contextBridge.executeInMainWorld({
  func: installBrowserPrintGuard,
  args: [
    () => {
      if (agentLed === false) {
        return true
      }
      ipcRenderer.send(BROWSER_PRINT_REFUSED_CHANNEL)
      return false
    }
  ]
})
