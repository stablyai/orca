import { ipcMain } from 'electron'
import { registerLazyIpcHandleGroup } from '../lazy-ipc-handle-group'

export const EMULATOR_IPC_CHANNELS = [
  'emulator:frameStreamStart',
  'emulator:frameStreamStop',
  'emulator:videoStreamStart',
  'emulator:videoStreamStop',
  'emulator:scrcpyKeyboard'
] as const

export function registerLazyEmulatorHandlers(
  resolveIosVideoStreamUrl: (deviceId: string) => string | null | undefined
): void {
  registerLazyIpcHandleGroup(EMULATOR_IPC_CHANNELS, async (ipc) => {
    const [
      { registerEmulatorFrameStreamHandlers },
      { registerEmulatorVideoStreamHandlers },
      { registerEmulatorScrcpyKeyboardHandler },
      { pairedForwardAvccUrl }
    ] = await Promise.all([
      import('./emulator-frame-stream'),
      import('./emulator-video-stream'),
      import('./emulator-scrcpy-keyboard'),
      import('../../emulator/paired-emulator-video-url')
    ])
    registerEmulatorFrameStreamHandlers(ipc)
    registerEmulatorVideoStreamHandlers(
      (id, streamUrl) => pairedForwardAvccUrl(streamUrl) ?? resolveIosVideoStreamUrl(id),
      ipc
    )
    registerEmulatorScrcpyKeyboardHandler(ipc)
  })

  let touchHandler: ((event: Electron.IpcMainEvent, touch: unknown) => void) | null = null
  let touchPromise: Promise<(event: Electron.IpcMainEvent, touch: unknown) => void> | null = null
  ipcMain.removeAllListeners('emulator:scrcpyTouch')
  ipcMain.on('emulator:scrcpyTouch', (event, touch: unknown) => {
    if (touchHandler) {
      touchHandler(event, touch)
      return
    }
    if (!touchPromise) {
      touchPromise = import('./emulator-scrcpy-touch')
        .then(({ handleEmulatorScrcpyTouch }) => {
          touchHandler = handleEmulatorScrcpyTouch
          return handleEmulatorScrcpyTouch
        })
        .catch((error: unknown) => {
          touchPromise = null
          throw error
        })
    }
    void touchPromise.then(
      (handle) => handle(event, touch),
      (error: unknown) => console.warn('[emulator] failed to load scrcpy touch handler:', error)
    )
  })
}
