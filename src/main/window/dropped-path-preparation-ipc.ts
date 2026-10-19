import { app, ipcMain, type BrowserWindow } from 'electron'
import {
  createRejectedNativeFileDropPayload,
  validateNativeFileDropPaths
} from '../../shared/native-file-drop'
import type {
  PrepareDroppedPathsRequest,
  PreparedDroppedPaths
} from '../../shared/native-file-drop-preparation'
import { abortWhenRendererGone } from '../ipc/renderer-lifetime-abort'
import { getDragTempCopyRoot, scheduleDragTempCopySweep } from './dragged-temp-file-copy'
import {
  createDroppedPathPreparationQueue,
  windowDragTempCopyLane
} from './dropped-path-preparation'
import { getDarwinUserTempDir } from './darwin-user-temp-dir'

export function registerDroppedPathPreparation(mainWindow: BrowserWindow): void {
  const prepareChannel = 'fs:prepareDroppedPaths'
  const mainWebContents = mainWindow.webContents
  const isWindowGone = (): boolean => mainWindow.isDestroyed() || mainWebContents.isDestroyed()
  ipcMain.removeHandler(prepareChannel)
  const prepare = createDroppedPathPreparationQueue(
    {
      platform: process.platform,
      getCopyEnvironment: async () => ({
        platform: process.platform,
        sourceTempRoot: await getDarwinUserTempDir(),
        copyRoot: getDragTempCopyRoot(app.getPath('temp'))
      }),
      watchRenderer: () => abortWhenRendererGone(mainWebContents)
    },
    windowDragTempCopyLane
  )
  const prepareHandler = (
    event: Electron.IpcMainInvokeEvent,
    args: unknown
  ): Promise<PreparedDroppedPaths> => {
    if (isWindowGone() || event.sender !== mainWebContents) {
      throw new Error('Dropped paths must come from the owning window')
    }
    if (!isPrepareDroppedPathsRequest(args)) {
      throw new Error('Invalid dropped paths request')
    }
    const validation = validateNativeFileDropPaths(args.paths)
    if (validation.status === 'rejected') {
      return Promise.resolve({
        paths: [],
        failures: [createRejectedNativeFileDropPayload(validation)]
      })
    }
    return Promise.resolve(prepare(args))
  }
  ipcMain.handle(prepareChannel, prepareHandler)
  activePrepareHandler = prepareHandler
  mainWindow.on('closed', () => {
    // Why: an old window closing late must not remove the replacement window's handler.
    if (activePrepareHandler === prepareHandler) {
      ipcMain.removeHandler(prepareChannel)
      activePrepareHandler = undefined
    }
  })
  scheduleDragTempCopySweep(() => getDragTempCopyRoot(app.getPath('temp')))
}

let activePrepareHandler: unknown

function isPrepareDroppedPathsRequest(value: unknown): value is PrepareDroppedPathsRequest {
  return (
    !!value &&
    typeof value === 'object' &&
    'consumer' in value &&
    (value.consumer === 'agent' || value.consumer === 'main-reader') &&
    'paths' in value &&
    Array.isArray(value.paths) &&
    value.paths.every((path: unknown) => typeof path === 'string')
  )
}
