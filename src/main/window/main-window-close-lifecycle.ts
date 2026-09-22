import { ipcMain, Menu, Notification, type BrowserWindow } from 'electron'
import { QUIT_RENDERER_ACK_TIMEOUT_MS } from '../../shared/quit-teardown-deadline'
import { translateMain } from '../i18n/main-i18n'
import type { Store } from '../persistence'
import { resolveWindowCloseAction } from './window-close-decision'
import type { CreateMainWindowOptions } from './main-window-contracts'
import type { MainWindowFocusLifecycle } from './main-window-focus-lifecycle'
import type { MainWindowStateLifecycle } from './main-window-state-lifecycle'
import { syncTrafficLightPosition } from './main-window-visual-lifecycle'

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
  // Intercept close so the renderer can confirm killing running-process terminals (replies window:confirm-close to proceed).
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
    // Why: will-quit cannot run until the renderer-backed window closes; an
    // already-frozen renderer otherwise makes Force Quit the only escape.
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

  // Windows minimize-to-tray: hide instead of close when enabled; returns true when it hid so callers skip their close path.
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
    // Why: notify once that closing only hid the window; the persisted flag stops it repeating on every later minimize.
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
    // Why: Alt+F4/programmatic closes hit the native event; apply the same minimize-to-tray guard the renderer-drawn X uses.
    if (!windowCloseConfirmed && hideToTrayIfEnabled()) {
      e.preventDefault()
      return
    }
    const isRendererCrashed = mainWindow.webContents.isCrashed?.() ?? false
    // Why: only a gone/crashed renderer (can't answer) may bypass close confirmation; a hung-but-alive one still must (#5787).
    const closeAction = resolveWindowCloseAction({
      windowCloseConfirmed,
      rendererProcessGone: focus.isRendererProcessGone(),
      isRendererCrashed
    })
    if (closeAction !== 'request-confirmation') {
      // allow-confirmed: renderer already replied and re-entered close().
      // bypass-gone: a gone renderer can't answer window:close-requested, so let OS close complete rather than trap a blank window.
      if (closeAction === 'allow-confirmed') {
        windowCloseConfirmed = false
      }
      // Why: window teardown emits resize/move/unmaximize; freeze bounds persistence so they can't clobber saved size (v1.3.26-rc2).
      state.freezeBoundsOnQuit()
      return
    }
    e.preventDefault()
    const isQuitting = opts?.getIsQuitting?.() ?? false
    const requestId = ++closeRequestSequence
    if (isQuitting) {
      armQuitRendererAckTimer(requestId)
    }
    // Why: renderer owns the close decision; the always-mounted App root subscription lets even pre-workspace states reply (#5144).
    mainWindow.webContents.send('window:close-requested', {
      isQuitting,
      requestId
    })
  })
  mainWindow.webContents.on('will-prevent-unload', () => {
    // Why: a prevented beforeunload cancels the quit; release the bounds-persistence freeze so later resizing still saves.
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

  // Why: renderer-drawn window controls on Windows/Linux replicate the native title-bar buttons hidden by custom chrome.
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
  // Why: mainWindow.close() from an IPC handler on Windows can make 'close' misfire, so send window:close-requested directly.
  const requestCloseChannel = 'window:request-close'
  const onRequestClose = (): void => {
    if (mainWindow.isDestroyed()) {
      return
    }
    // Why: renderer-drawn X routes here (not the native close event), so the minimize-to-tray guard must also run here.
    if (hideToTrayIfEnabled()) {
      return
    }
    mainWindow.webContents.send('window:close-requested', { isQuitting: false })
  }
  // Why: renderer-drawn title-bar ··· menu button replicates the Alt-key reveal autoHideMenuBar provides (Windows/Linux).
  const popupMenuChannel = 'menu:popup'
  const onPopupMenu = (): void => {
    Menu.getApplicationMenu()?.popup({ window: mainWindow })
  }
  // Why: WindowControls mounts after window:maximize-changed already fired, so expose a synchronous getter to init its icon.
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
