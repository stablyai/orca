import { BrowserWindow, ipcMain, type WebContents } from 'electron'
import type { Store } from '../persistence'
import type { PersistedUIState } from '../../shared/persisted-ui-state-types'
import { isFeatureInteractionId } from '../../shared/feature-interactions'
import { orcaWindowManager } from '../window/orca-window-manager'

export function sendToTrustedUIRenderer(
  channel: string,
  payload: unknown,
  excludedWebContentsId?: number
): void {
  const renderer = getTrustedUIRendererWebContents(excludedWebContentsId)
  renderer?.send(channel, payload)
}

export function broadcastToTrustedUIRenderers(
  channel: string,
  payload: unknown,
  excludedWebContentsId?: number
): void {
  for (const window of orcaWindowManager.getAllWindows()) {
    const renderer = window.webContents
    if (!renderer.isDestroyed() && renderer.id !== excludedWebContentsId) {
      renderer.send(channel, payload)
    }
  }
}

export function getTrustedUIRendererWebContents(
  excludedWebContentsId?: number
): WebContents | null {
  const controlRenderer = orcaWindowManager.getControlWindow()?.webContents
  if (
    !controlRenderer ||
    controlRenderer.isDestroyed() ||
    controlRenderer.id === excludedWebContentsId
  ) {
    return null
  }
  return controlRenderer
}

export function getTrustedUIRendererWindow(): BrowserWindow | null {
  return orcaWindowManager.getControlWindow()
}

export function registerUIHandlers(
  store: Store,
  options: { isDashboardPopoutRenderer?: (sender: WebContents) => boolean } = {}
): void {
  // Why: UI view-state is shared between the desktop renderer and mobile (ui.set
  // RPC). Broadcast every change so the desktop re-hydrates when mobile (or
  // another window) updates it — bi-directional sync, mirroring settings:changed.
  store.onUIChanged((ui) => {
    broadcastToTrustedUIRenderers('ui:stateChanged', ui)
  })

  ipcMain.handle('ui:get', () => {
    return store.getUI()
  })

  ipcMain.handle('ui:set', (_event, args: Partial<PersistedUIState>) => {
    store.updateUI(args)
  })

  ipcMain.handle('ui:recordFeatureInteraction', (_event, id: unknown) => {
    if (!isFeatureInteractionId(id)) {
      throw new Error('invalid_feature_interaction_id')
    }
    return store.recordFeatureInteraction(id)
  })

  ipcMain.handle('window:isMaximized', (event) => {
    if (!isTrustedUIRenderer(event.sender)) {
      return false
    }
    const window =
      orcaWindowManager.getWindowForSender(event.sender) ??
      BrowserWindow.fromWebContents(event.sender)
    return window != null && !window.isDestroyed() && window.isMaximized()
  })

  ipcMain.removeAllListeners('ui:performNativePaste')
  ipcMain.on('ui:performNativePaste', (event, options?: { mode?: unknown }) => {
    if (!isTrustedUIRenderer(event.sender)) {
      return
    }
    // Why: coordinated renderer paste falls back here only after no Orca owner
    // claims the app-menu action; paste back into the requesting window only.
    const webContents = BrowserWindow.fromWebContents(event.sender)?.webContents
    if (options?.mode === 'paste-and-match-style') {
      webContents?.pasteAndMatchStyle()
      return
    }
    webContents?.paste()
  })

  ipcMain.removeAllListeners('ui:performNativeSelectionAction')
  ipcMain.on('ui:performNativeSelectionAction', (event, action: unknown) => {
    if (
      !isTrustedUIRenderer(event.sender) &&
      options.isDashboardPopoutRenderer?.(event.sender) !== true
    ) {
      return
    }
    const target = BrowserWindow.fromWebContents(event.sender)?.webContents
    if (action === 'copy') {
      target?.copy()
    } else if (action === 'select-all') {
      target?.selectAll()
    }
  })
}

export function isTrustedUIRenderer(sender: WebContents): boolean {
  return orcaWindowManager.isTrustedSender(sender)
}
