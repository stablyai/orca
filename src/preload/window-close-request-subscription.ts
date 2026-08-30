import type { IpcRenderer } from 'electron'
import {
  readWindowCloseRequestPayload,
  type WindowCloseRequestPayload
} from '../shared/window-close-request'

const CLOSE_REQUESTED_CHANNEL = 'window:close-requested'
const CLOSE_REQUEST_RECEIVED_CHANNEL = 'window:close-request-received'

/**
 * Subscribes the renderer to main's `window:close-requested`.
 *
 * Why the payload is read here and not forwarded: this is the only boundary the
 * survival answer crosses untyped, and the renderer spends
 * `localPtysSurviveQuit: true` as permission to close over running work with no
 * warning. So the rule that only an explicit yes is a yes lives once, in
 * `readWindowCloseRequestPayload`, and this is its single call site — forwarding
 * the raw payload would restore the unconditional quit bypass for anything that
 * is not a clean boolean (docs/reference/ssh-execution-boundary.md).
 *
 * Extracted from the api object so that hop is reachable by a test at all; while
 * it was inline in index.ts nothing in the tree could observe it.
 */
export function subscribeToWindowCloseRequest(
  ipcRenderer: Pick<IpcRenderer, 'on' | 'removeListener' | 'send'>,
  callback: (data: WindowCloseRequestPayload) => void
): () => void {
  const listener = (_event: Electron.IpcRendererEvent, data: unknown): void => {
    const payload = readWindowCloseRequestPayload(data)
    // Why: main cannot reach will-quit while a frozen renderer owns the window close handshake.
    ipcRenderer.send(CLOSE_REQUEST_RECEIVED_CHANNEL, payload.requestId)
    callback(payload)
  }
  ipcRenderer.on(CLOSE_REQUESTED_CHANNEL, listener)
  return () => ipcRenderer.removeListener(CLOSE_REQUESTED_CHANNEL, listener)
}
