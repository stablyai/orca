import { ipcMain, Menu, Notification, type BrowserWindow } from 'electron'
import { QUIT_RENDERER_ACK_TIMEOUT_MS } from '../../shared/quit-teardown-deadline'
import { translateMain } from '../i18n/main-i18n'
import type { Store } from '../persistence'
import { resolveWindowCloseAction } from './window-close-decision'
import type { CreateMainWindowOptions } from './main-window-contracts'
import type { MainWindowFocusLifecycle } from './main-window-focus-lifecycle'
import type { MainWindowStateLifecycle } from './main-window-state-lifecycle'
import { syncTrafficLightPosition } from './main-window-visual-lifecycle'
import { consumeUserQuitWindowClose } from './user-quit-window-close'

export const WINDOW_QUIT_RENDERER_ACK_TIMEOUT_MS = QUIT_RENDERER_ACK_TIMEOUT_MS

export function installMainWindowCloseLifecycle(args: {
  focus: MainWindowFocusLifecycle
  mainWindow: BrowserWindow
  opts?: CreateMainWindowOptions
  rendererWebContentsId: number
  state: MainWindowStateLifecycle
  store: Store | null
}): { dispose: () => void } {
  const { focus, mainWindow, opts, rendererWebContentsId, state, store } = args
  // Renderer confirms save/process guards through window:confirm-close.
  let windowCloseConfirmed = false
  const confirmCloseChannel = 'window:confirm-close'
  const closeRequestReceivedChannel = 'window:close-request-received'
  let closeRequestSequence = 0
  let quitRendererAckRequestId: number | null = null
  let quitRendererAckTimer: ReturnType<typeof setTimeout> | null = null
  const clearQuitRendererAckTimer = (): void => {
    quitRendererAckRequestId = null
    if (quitRendererAckTimer) {
      clearTimeout(quitRendererAckTimer)
      quitRendererAckTimer = null
    }
  }
  const armQuitRendererAckTimer = (requestId: number): void => {
    quitRendererAckRequestId = requestId
    if (quitRendererAckTimer) {
      return
    }
    // will-quit waits for window close; bound frozen-renderer acknowledgement so Quit remains usable.
    quitRendererAckTimer = setTimeout(() => {
      quitRendererAckTimer = null
      quitRendererAckRequestId = null
      if (mainWindow.isDestroyed()) {
        return
      }
      console.warn('[window] Renderer did not acknowledge quit; destroying unresponsive window')
      state.freezeBoundsOnQuit()
      mainWindow.destroy()
    }, WINDOW_QUIT_RENDERER_ACK_TIMEOUT_MS)
    quitRendererAckTimer.unref?.()
  }
  const onCloseRequestReceived = (event: Electron.IpcMainEvent, requestId: number): void => {
    if (event.sender.id === rendererWebContentsId && requestId === quitRendererAckRequestId) {
      clearQuitRendererAckTimer()
    }
  }

  // Windows tray minimization owns close when enabled; callers must skip their normal close path.
  const hideToTrayIfEnabled = (): boolean => {
    const isRendererCrashed = mainWindow.webContents.isCrashed?.() ?? false
    if (
      process.platform !== 'win32' ||
      focus.isRendererProcessGone() ||
      isRendererCrashed ||
      opts?.getIsQuitting?.() === true ||
      store?.getSettings().minimizeToTrayOnClose !== true
    ) {
      return false
    }
    mainWindow.hide()
    // Persist the one-time tray notice so later minimize actions stay quiet.
    if (store.getUI().trayMinimizeNoticeShown !== true) {
      try {
        new Notification({
          title: 'Orca',
          body: translateMain(
            'tray.minimizeNotice.body',
            'Orca is still running in the system tray'
          )
        }).show()
      } catch {
        // Notification is best-effort — never block hiding the window.
      }
      store.updateUI({ trayMinimizeNoticeShown: true })
    }
    return true
  }

  mainWindow.on('close', (e) => {
    const userQuitClose = consumeUserQuitWindowClose(mainWindow)
    // Alt+F4/programmatic closes need the same tray guard as the custom X.
    if (!windowCloseConfirmed && !userQuitClose && hideToTrayIfEnabled()) {
      e.preventDefault()
      return
    }
    const isRendererCrashed = mainWindow.webContents.isCrashed?.() ?? false
    // Only gone/crashed renderers can bypass confirmation; hung-but-live renderers must answer (#5787).
    const closeAction = resolveWindowCloseAction({
      windowCloseConfirmed,
      rendererProcessGone: focus.isRendererProcessGone(),
      isRendererCrashed
    })
    if (closeAction !== 'request-confirmation') {
      // Confirmed close reenters here; truly gone renderers cannot answer and must remain closable.
      if (closeAction === 'allow-confirmed') {
        windowCloseConfirmed = false
      }
      // Freeze remembered bounds before teardown resize/move/unmaximize events can overwrite them.
      state.freezeBoundsOnQuit()
      return
    }
    e.preventDefault()
    const isQuitting = opts?.getIsQuitting?.() ?? false
    const requestId = ++closeRequestSequence
    // User Quit on serve closes windows without quitting the host; still bound frozen-renderer acknowledgement.
    if (isQuitting || userQuitClose) {
      armQuitRendererAckTimer(requestId)
    }
    // The always-mounted App subscription can confirm even before a workspace exists (#5144).
    mainWindow.webContents.send('window:close-requested', {
      isQuitting,
      requestId
    })
  })
  mainWindow.webContents.on('will-prevent-unload', () => {
    // A veto cancels quit; resume bounds persistence for subsequent user resizing.
    state.resumeBoundsPersistence()
    clearQuitRendererAckTimer()
    opts?.onQuitAborted?.()
    mainWindow.webContents.send('window:unload-prevented')
  })

  const onConfirmClose = (): void => {
    clearQuitRendererAckTimer()
    windowCloseConfirmed = true
    if (!mainWindow.isDestroyed()) {
      mainWindow.close()
    }
  }
  const trafficLightChannel = 'ui:sync-traffic-lights'
  const onSyncTrafficLights = (_event: Electron.IpcMainEvent, zoomFactor: number): void => {
    syncTrafficLightPosition(mainWindow, zoomFactor)
  }
  ipcMain.on(trafficLightChannel, onSyncTrafficLights)

  // Custom Windows/Linux controls replace hidden native titlebar buttons.
  const minimizeChannel = 'window:minimize'
  const onMinimize = (): void => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.minimize()
    }
  }
  const maximizeChannel = 'window:maximize'
  const onMaximize = (): void => {
    if (mainWindow.isDestroyed()) {
      return
    }
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize()
    } else {
      mainWindow.maximize()
    }
  }
  // Windows close from IPC can misfire; send the renderer close request directly.
  const requestCloseChannel = 'window:request-close'
  const onRequestClose = (): void => {
    if (mainWindow.isDestroyed()) {
      return
    }
    // Custom X bypasses native close; apply the tray guard here too.
    if (hideToTrayIfEnabled()) {
      return
    }
    mainWindow.webContents.send('window:close-requested', { isQuitting: false })
  }
  // Custom titlebar menu replaces Alt reveal of the hidden Windows/Linux menu.
  const popupMenuChannel = 'menu:popup'
  const onPopupMenu = (): void => {
    Menu.getApplicationMenu()?.popup({ window: mainWindow })
  }
  // Controls mount after the first maximize event; expose current state for their initial icon.
  const isMaximizedChannel = 'window:isMaximized'
  const onIsMaximized = (): boolean => {
    return !mainWindow.isDestroyed() && mainWindow.isMaximized()
  }
  ipcMain.on(minimizeChannel, onMinimize)
  ipcMain.on(maximizeChannel, onMaximize)
  ipcMain.on(requestCloseChannel, onRequestClose)
  ipcMain.on(popupMenuChannel, onPopupMenu)
  ipcMain.handle(isMaximizedChannel, onIsMaximized)

  ipcMain.on(confirmCloseChannel, onConfirmClose)
  ipcMain.on(closeRequestReceivedChannel, onCloseRequestReceived)

  const dispose = (): void => {
    clearQuitRendererAckTimer()
    ipcMain.removeListener(trafficLightChannel, onSyncTrafficLights)
    ipcMain.removeListener(minimizeChannel, onMinimize)
    ipcMain.removeListener(maximizeChannel, onMaximize)
    ipcMain.removeListener(requestCloseChannel, onRequestClose)
    ipcMain.removeListener(popupMenuChannel, onPopupMenu)
    ipcMain.removeHandler(isMaximizedChannel)
    ipcMain.removeListener(confirmCloseChannel, onConfirmClose)
    ipcMain.removeListener(closeRequestReceivedChannel, onCloseRequestReceived)
  }
  return { dispose }
}
