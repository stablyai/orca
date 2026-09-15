import {
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
  type IpcMainInvokeEvent,
  type OpenDialogOptions
} from 'electron'
import { WORKSPACE_WINDOW_NATIVE_CHANNELS } from '../../shared/workspace-window-native-bridge'
import { normalizeExternalBrowserUrl } from '../../shared/browser-url'
import { safelyRevealWindow } from './focus-existing-window'
import { acknowledgeWorkspaceWindowClose } from './workspace-window-close-lifecycle'

type AuthorizedWorkspaceWindow = {
  origin: string
  window: BrowserWindow
  windowId?: string
}

const authorizedWindows = new Map<number, AuthorizedWorkspaceWindow>()
let retainedPrimaryWindow: BrowserWindow | null = null

export function isRetainedWorkspacePrimary(window: BrowserWindow): boolean {
  return retainedPrimaryWindow === window && !window.isVisible()
}

export function retainPrimaryWindowForWorkspaces(window: BrowserWindow): boolean {
  if (authorizedWindows.size === 0) {
    return false
  }
  retainedPrimaryWindow = window
  window.hide()
  window.emit('workspace-presentation-retained')
  return true
}

function getAuthorizedWindow(event: IpcMainInvokeEvent): AuthorizedWorkspaceWindow {
  const authorized = authorizedWindows.get(event.sender.id)
  let senderOrigin: string | null = null
  try {
    senderOrigin = event.senderFrame ? new URL(event.senderFrame.url).origin : null
  } catch {
    senderOrigin = null
  }
  const window = BrowserWindow.fromWebContents(event.sender)
  if (
    !authorized ||
    event.senderFrame !== event.sender.mainFrame ||
    senderOrigin !== authorized.origin ||
    window !== authorized.window
  ) {
    throw new Error('workspace_window_native_bridge_unauthorized')
  }
  return authorized
}

export function authorizeWorkspaceWindowEvent(event: IpcMainInvokeEvent): BrowserWindow {
  return getAuthorizedWindow(event).window
}

export function getWorkspaceWindowNavigationId(event: IpcMainInvokeEvent): string {
  const { windowId } = getAuthorizedWindow(event)
  if (!windowId) {
    throw new Error('workspace_window_navigation_identity_unavailable')
  }
  return windowId
}

async function pickDirectories(
  event: IpcMainInvokeEvent,
  properties: OpenDialogOptions['properties']
): Promise<string[]> {
  const { window } = getAuthorizedWindow(event)
  const result = await dialog.showOpenDialog(window, { properties })
  return result.canceled ? [] : result.filePaths
}

export function authorizeWorkspaceWindowNativeBridge(
  window: BrowserWindow,
  rendererUrl: string,
  windowId?: string
): void {
  const webContentsId = window.webContents.id
  const origin = new URL(rendererUrl).origin
  authorizedWindows.set(webContentsId, {
    origin,
    window,
    windowId
  })
  const containNavigation = (event: Electron.Event, url: string): void => {
    if (new URL(url).origin !== origin) {
      event.preventDefault()
    }
  }
  window.webContents.on('will-navigate', containNavigation)
  window.webContents.on('will-redirect', containNavigation)
  window.webContents.setWindowOpenHandler(({ url }) => {
    const externalUrl = normalizeExternalBrowserUrl(url)
    if (externalUrl) {
      void shell.openExternal(externalUrl)
    }
    return { action: 'deny' }
  })
  window.once('closed', () => {
    authorizedWindows.delete(webContentsId)
    if (authorizedWindows.size === 0 && retainedPrimaryWindow) {
      const primary = retainedPrimaryWindow
      retainedPrimaryWindow = null
      if (!primary.isDestroyed() && !primary.isVisible()) {
        safelyRevealWindow(primary)
        primary.close()
      }
    }
  })
}

export function registerWorkspaceWindowNativeBridge(): void {
  ipcMain.handle('workspaceWindow:closeRequestReceived', (event, requestId: number) => {
    acknowledgeWorkspaceWindowClose(getAuthorizedWindow(event).window, requestId)
  })
  ipcMain.handle(WORKSPACE_WINDOW_NATIVE_CHANNELS.requestClose, (event) => {
    getAuthorizedWindow(event).window.close()
  })
  ipcMain.handle(WORKSPACE_WINDOW_NATIVE_CHANNELS.confirmClose, (event) => {
    const { window } = getAuthorizedWindow(event)
    window.destroy()
    return window.isDestroyed()
  })
  ipcMain.handle(
    WORKSPACE_WINDOW_NATIVE_CHANNELS.getWindowId,
    (event) => getAuthorizedWindow(event).window.id
  )
  ipcMain.handle(WORKSPACE_WINDOW_NATIVE_CHANNELS.pickFolder, async (event) => {
    const paths = await pickDirectories(event, ['openDirectory'])
    return paths[0] ?? null
  })
  ipcMain.handle(WORKSPACE_WINDOW_NATIVE_CHANNELS.pickFolders, (event) =>
    pickDirectories(event, ['openDirectory', 'multiSelections'])
  )
  ipcMain.handle(WORKSPACE_WINDOW_NATIVE_CHANNELS.pickDirectory, async (event) => {
    const paths = await pickDirectories(event, ['openDirectory'])
    return paths[0] ?? null
  })
}
