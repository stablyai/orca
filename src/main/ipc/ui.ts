import { BrowserWindow, ipcMain, type WebContents } from 'electron'
import type { Store } from '../persistence'
import type { PersistedUIState } from '../../shared/types'
import { isFeatureInteractionId } from '../../shared/feature-interactions'

let trustedUIRendererWebContentsId: number | null = null

export function setTrustedUIRendererWebContentsId(webContentsId: number | null): void {
  trustedUIRendererWebContentsId = webContentsId
}

export function clearTrustedUIRendererWebContentsId(webContentsId: number): void {
  if (trustedUIRendererWebContentsId === webContentsId) {
    trustedUIRendererWebContentsId = null
  }
}

export function registerUIHandlers(store: Store): void {
  // Why: UI view-state is shared between the desktop renderer and mobile (ui.set
  // RPC). Broadcast every change so the desktop re-hydrates when mobile (or
  // another window) updates it — bi-directional sync, mirroring settings:changed.
  store.onUIChanged((ui) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send('ui:stateChanged', ui)
      }
    }
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
}

function isTrustedUIRenderer(sender: WebContents): boolean {
  if (sender.isDestroyed() || sender.getType() !== 'window') {
    return false
  }
  if (trustedUIRendererWebContentsId != null) {
    return sender.id === trustedUIRendererWebContentsId
  }

  const senderUrl = sender.getURL()
  if (process.env.ELECTRON_RENDERER_URL) {
    try {
      return new URL(senderUrl).origin === new URL(process.env.ELECTRON_RENDERER_URL).origin
    } catch {
      return false
    }
  }

  // Why: packaged fallback must be tied to the created main window id, not any
  // file:// document that can obtain this IPC channel.
  return false
}
