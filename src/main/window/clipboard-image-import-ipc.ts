import { app, clipboard, ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { ClipboardImageImportStaging } from './clipboard-image-import-staging'
import { readClipboardImageForImport } from './clipboard-image-import-source'
import { readClipboardNativeImage } from './clipboard-native-image'

let staging: ClipboardImageImportStaging | undefined
let sweepTimer: ReturnType<typeof setInterval> | undefined
const owners = new WeakMap<WebContents, AbortController>()

function sweepExpired(): void {
  void getStaging()
    .sweepExpired()
    .catch((error) => {
      console.error('[clipboard] Failed to sweep image import staging', error)
    })
}

function getStaging(): ClipboardImageImportStaging {
  if (!staging) {
    staging = new ClipboardImageImportStaging(app.getPath('userData'))
  }
  return staging
}

function captureOwner(sender: WebContents): AbortSignal {
  const current = owners.get(sender)
  if (current) {
    return current.signal
  }
  const owner = new AbortController()
  owners.set(sender, owner)
  const release = (): void => {
    owner.abort()
    owners.delete(sender)
    sender.removeListener('destroyed', release)
    sender.removeListener('render-process-gone', release)
    sender.removeListener('did-start-navigation', onNavigation)
    void getStaging().releaseOwner(sender.id)
  }
  const onNavigation = (
    _event: Electron.Event,
    _url: string,
    isInPlace: boolean,
    isMainFrame: boolean
  ): void => {
    if (isMainFrame && !isInPlace) {
      release()
    }
  }
  sender.once('destroyed', release)
  sender.once('render-process-gone', release)
  sender.on('did-start-navigation', onNavigation)
  return owner.signal
}

export function registerClipboardImageImportHandlers(
  assertTrustedSender: (event: IpcMainInvokeEvent) => void
): void {
  ipcMain.removeHandler('clipboard:stageImageForImport')
  ipcMain.removeHandler('clipboard:releaseImageImport')
  ipcMain.handle('clipboard:stageImageForImport', (event) => {
    assertTrustedSender(event)
    // Shares chat paste's reader, which decodes CleanShot JPEGs stored as macOS public.png.
    const buffer = readClipboardImageForImport(
      clipboard,
      process.platform,
      readClipboardNativeImage
    )
    if (!buffer) {
      return null
    }
    return getStaging().stage(event.sender.id, buffer, captureOwner(event.sender))
  })
  ipcMain.handle('clipboard:releaseImageImport', (event, handle: unknown) => {
    assertTrustedSender(event)
    return getStaging().release(event.sender.id, handle)
  })
  sweepExpired()
  if (!sweepTimer) {
    // Recover recent crash leftovers even when the app stays open past their expiry.
    sweepTimer = setInterval(sweepExpired, 60 * 60 * 1000)
    sweepTimer.unref()
  }
}
