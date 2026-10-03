import { ipcRenderer } from 'electron'
import { LSP_PORT_CHANNEL, LSP_PORT_WINDOW_MESSAGE } from '../../shared/language-server-types'
import type { LspApi } from './lsp-api'

export const lspApi: LspApi = {
  open: (args) => ipcRenderer.invoke('lsp:open', args),
  probe: (args) => ipcRenderer.invoke('lsp:probe', args)
}

/** Why: contextBridge cannot carry a MessagePort, so hand it to the main world via window.postMessage. */
export function installLspPortForwarding(): void {
  ipcRenderer.on(LSP_PORT_CHANNEL, (event, payload: unknown) => {
    const requestId =
      typeof payload === 'object' && payload !== null && 'requestId' in payload
        ? payload.requestId
        : null
    if (typeof requestId === 'string') {
      window.postMessage({ type: LSP_PORT_WINDOW_MESSAGE, requestId }, '*', event.ports)
    }
  })
}
