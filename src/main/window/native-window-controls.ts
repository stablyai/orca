import { ipcMain, Menu, type BrowserWindow, type IpcMainEvent } from 'electron'

const windows = new Map<number, BrowserWindow>()
const isMaximizedChannel = 'window:isMaximized'

export function installNativeWindowControls(args: {
  window: BrowserWindow
  requestClose: () => void
  confirmClose: () => void
  syncTrafficLights: (zoomFactor: number) => void
}): () => void {
  const { window } = args
  const renderer = window.webContents
  const rendererId = renderer.id
  const ownsEvent = (event: IpcMainEvent): boolean =>
    !window.isDestroyed() && event.sender === renderer
  const minimize = (event: IpcMainEvent): void => {
    if (ownsEvent(event)) {
      window.minimize()
    }
  }
  const maximize = (event: IpcMainEvent): void => {
    if (!ownsEvent(event)) {
      return
    }
    if (window.isMaximized()) {
      window.unmaximize()
    } else {
      window.maximize()
    }
  }
  const requestClose = (event: IpcMainEvent): void => {
    if (ownsEvent(event)) {
      args.requestClose()
    }
  }
  const confirmClose = (event: IpcMainEvent): void => {
    if (ownsEvent(event)) {
      args.confirmClose()
    }
  }
  const syncTrafficLights = (event: IpcMainEvent, zoomFactor: number): void => {
    if (ownsEvent(event) && Number.isFinite(zoomFactor) && zoomFactor > 0) {
      args.syncTrafficLights(zoomFactor)
    }
  }
  const popupMenu = (event: IpcMainEvent): void => {
    if (ownsEvent(event)) {
      Menu.getApplicationMenu()?.popup({ window })
    }
  }
  windows.set(rendererId, window)
  ipcMain.removeHandler(isMaximizedChannel)
  ipcMain.handle(isMaximizedChannel, (event) => {
    const target = windows.get(event.sender.id)
    return Boolean(
      target && !target.isDestroyed() && target.webContents === event.sender && target.isMaximized()
    )
  })
  ipcMain.on('window:minimize', minimize)
  ipcMain.on('window:maximize', maximize)
  ipcMain.on('window:request-close', requestClose)
  ipcMain.on('window:confirm-close', confirmClose)
  ipcMain.on('ui:sync-traffic-lights', syncTrafficLights)
  ipcMain.on('menu:popup', popupMenu)

  return () => {
    ipcMain.removeListener('window:minimize', minimize)
    ipcMain.removeListener('window:maximize', maximize)
    ipcMain.removeListener('window:request-close', requestClose)
    ipcMain.removeListener('window:confirm-close', confirmClose)
    ipcMain.removeListener('ui:sync-traffic-lights', syncTrafficLights)
    ipcMain.removeListener('menu:popup', popupMenu)
    if (windows.get(rendererId) === window) {
      windows.delete(rendererId)
    }
    if (windows.size === 0) {
      ipcMain.removeHandler(isMaximizedChannel)
    }
  }
}
