import { app, ipcMain, type BrowserWindow, type WebContents } from 'electron'
import {
  createRejectedNativeFileDropPayload,
  validateNativeFileDropPaths
} from '../../shared/native-file-drop'
import type {
  PrepareDroppedPathsRequest,
  PreparedDroppedPaths
} from '../../shared/native-file-drop-preparation'
import { abortWhenRendererGone } from '../ipc/renderer-lifetime-abort'
import { getDragTempCopyRoot } from './dragged-temp-file-copy'
import {
  createDroppedPathPreparationQueue,
  windowDragTempCopyLane,
  type DroppedPathPreparationDeps
} from './dropped-path-preparation'
import { getDarwinUserTempDir } from './darwin-user-temp-dir'

type WindowPreparation = {
  prepare: ReturnType<typeof createDroppedPathPreparationQueue>
  isGone: () => boolean
}

const preparations = new Map<WebContents, WindowPreparation>()

export function registerDroppedPathPreparation(
  mainWindow: BrowserWindow,
  localChatAttachmentStore?: DroppedPathPreparationDeps['localChatAttachmentStore']
): void {
  const prepareChannel = 'fs:prepareDroppedPaths'
  const mainWebContents = mainWindow.webContents
  const isWindowGone = (): boolean => mainWindow.isDestroyed() || mainWebContents.isDestroyed()
  ipcMain.removeHandler(prepareChannel)
  const prepare = createDroppedPathPreparationQueue(
    {
      platform: process.platform,
      localChatAttachmentStore,
      getCopyEnvironment: async () => ({
        platform: process.platform,
        sourceTempRoot: await getDarwinUserTempDir(),
        copyRoot: getDragTempCopyRoot(app.getPath('temp'))
      }),
      watchRenderer: () => abortWhenRendererGone(mainWebContents)
    },
    windowDragTempCopyLane
  )
  const entry = { prepare, isGone: isWindowGone }
  preparations.set(mainWebContents, entry)
  const prepareHandler = (
    event: Electron.IpcMainInvokeEvent,
    args: unknown
  ): Promise<PreparedDroppedPaths> => {
    const owner = preparations.get(event.sender)
    if (!owner || owner.isGone()) {
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
    return Promise.resolve(owner.prepare(args))
  }
  ipcMain.handle(prepareChannel, prepareHandler)
  mainWindow.on('closed', () => {
    // Why: an old window closing late must not remove the replacement window's handler.
    if (preparations.get(mainWebContents) === entry) {
      preparations.delete(mainWebContents)
    }
    if (preparations.size === 0) {
      ipcMain.removeHandler(prepareChannel)
    }
  })
}

function isPrepareDroppedPathsRequest(value: unknown): value is PrepareDroppedPathsRequest {
  return (
    !!value &&
    typeof value === 'object' &&
    'consumer' in value &&
    (value.consumer === 'agent' ||
      value.consumer === 'main-reader' ||
      value.consumer === 'local-chat') &&
    'paths' in value &&
    Array.isArray(value.paths) &&
    value.paths.every((path: unknown) => typeof path === 'string')
  )
}
