import type { BrowserWindow } from 'electron'
import { WORKSPACE_WINDOW_NATIVE_CHANNELS } from '../../shared/workspace-window-native-bridge'
import { RendererQuitAcknowledgement } from './renderer-quit-acknowledgement'
import { resolveWindowCloseAction } from './window-close-decision'

const acknowledgements = new WeakMap<BrowserWindow, RendererQuitAcknowledgement>()

export function acknowledgeWorkspaceWindowClose(window: BrowserWindow, requestId: number): void {
  acknowledgements.get(window)?.acknowledge(requestId)
}

export function installWorkspaceWindowCloseLifecycle(
  window: BrowserWindow,
  getIsQuitting: () => boolean
): void {
  let rendererProcessGone = false
  let sequence = 0
  const acknowledgement = new RendererQuitAcknowledgement(() => {
    if (!window.isDestroyed()) {
      window.destroy()
    }
  })
  acknowledgements.set(window, acknowledgement)
  window.webContents.on('render-process-gone', () => {
    rendererProcessGone = true
  })
  window.webContents.on('did-finish-load', () => {
    rendererProcessGone = false
  })
  window.on('close', (event) => {
    if (
      resolveWindowCloseAction({
        windowCloseConfirmed: false,
        rendererProcessGone,
        isRendererCrashed: window.webContents.isCrashed?.() ?? false
      }) !== 'request-confirmation'
    ) {
      return
    }
    event.preventDefault()
    const isQuitting = getIsQuitting()
    const requestId = ++sequence
    if (isQuitting) {
      acknowledgement.arm(requestId)
    }
    window.webContents.send(WORKSPACE_WINDOW_NATIVE_CHANNELS.closeRequested, {
      isQuitting,
      requestId
    })
  })
  window.once('closed', () => acknowledgement.clear())
}
