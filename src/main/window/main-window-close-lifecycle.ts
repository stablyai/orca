import { ipcMain, Notification, type BrowserWindow } from 'electron'
import { QUIT_RENDERER_ACK_TIMEOUT_MS } from '../../shared/quit-teardown-deadline'
import { translateMain } from '../i18n/main-i18n'
import type { Store } from '../persistence'
import { resolveWindowCloseAction } from './window-close-decision'
import type { CreateMainWindowOptions } from './main-window-contracts'
import type { MainWindowFocusLifecycle } from './main-window-focus-lifecycle'
import type { MainWindowStateLifecycle } from './main-window-state-lifecycle'
import { syncTrafficLightPosition } from './main-window-visual-lifecycle'
import { consumeUserQuitWindowClose } from './user-quit-window-close'
import { installNativeWindowControls } from './native-window-controls'

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
    const userQuitClose = consumeUserQuitWindowClose(mainWindow)
    // Why: Alt+F4/programmatic closes hit the native event; apply the same minimize-to-tray guard the renderer-drawn X uses.
    if (!windowCloseConfirmed && !userQuitClose && hideToTrayIfEnabled()) {
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
    // Why userQuitClose: a serve host's user Quit only closes windows, yet a frozen renderer must not trap it.
    if (isQuitting || userQuitClose) {
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
  // Why: mainWindow.close() from an IPC handler on Windows can make 'close' misfire, so send window:close-requested directly.
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
  const disposeControls = installNativeWindowControls({
    window: mainWindow,
    requestClose: onRequestClose,
    confirmClose: onConfirmClose,
    syncTrafficLights: (zoomFactor) => syncTrafficLightPosition(mainWindow, zoomFactor)
  })
  ipcMain.on(closeRequestReceivedChannel, onCloseRequestReceived)

  const dispose = (): void => {
    clearQuitRendererAckTimer()
    disposeControls()
    ipcMain.removeListener(closeRequestReceivedChannel, onCloseRequestReceived)
  }
  return { dispose }
}
