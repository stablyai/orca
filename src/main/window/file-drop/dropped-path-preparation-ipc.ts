import { app, ipcMain, type BrowserWindow } from 'electron'
import type {
  PrepareDroppedPathsRequest,
  PreparedDroppedPaths
} from '../../../shared/file-import/native-file-drop-preparation'
import type { DroppedPathPreparationDeps } from './dropped-path-preparation'

type DroppedPathPreparer = (
  request: PrepareDroppedPathsRequest
) => PreparedDroppedPaths | Promise<PreparedDroppedPaths>

export function registerDroppedPathPreparation(
  mainWindow: BrowserWindow,
  localChatAttachmentStore?: DroppedPathPreparationDeps['localChatAttachmentStore']
): void {
  const prepareChannel = 'fs:prepareDroppedPaths'
  const mainWebContents = mainWindow.webContents
  const isWindowGone = (): boolean => mainWindow.isDestroyed() || mainWebContents.isDestroyed()
  ipcMain.removeHandler(prepareChannel)
  let preparePromise: Promise<DroppedPathPreparer> | null = null
  const getPreparer = (): Promise<DroppedPathPreparer> => {
    if (!preparePromise) {
      preparePromise = Promise.all([
        import('./dropped-path-preparation'),
        import('./dragged-temp-file-copy'),
        import('./darwin-user-temp-dir'),
        import('../../ipc/renderer-requests/renderer-lifetime-abort')
      ]).then(
        ([
          { createDroppedPathPreparationQueue, windowDragTempCopyLane },
          { getDragTempCopyRoot },
          { getDarwinUserTempDir },
          { abortWhenRendererGone }
        ]) =>
          createDroppedPathPreparationQueue(
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
      )
    }
    return preparePromise
  }
  const prepareHandler = async (
    event: Electron.IpcMainInvokeEvent,
    args: unknown
  ): Promise<PreparedDroppedPaths> => {
    if (isWindowGone() || event.sender !== mainWebContents) {
      throw new Error('Dropped paths must come from the owning window')
    }
    if (!isPrepareDroppedPathsRequest(args)) {
      throw new Error('Invalid dropped paths request')
    }
    const { createRejectedNativeFileDropPayload, validateNativeFileDropPaths } =
      await import('../../../shared/file-import/native-file-drop')
    const validation = validateNativeFileDropPaths(args.paths)
    if (validation.status === 'rejected') {
      return {
        paths: [],
        failures: [createRejectedNativeFileDropPayload(validation)]
      }
    }
    const prepare = await getPreparer()
    return prepare(args)
  }
  ipcMain.handle(prepareChannel, prepareHandler)
  activePrepareHandler = prepareHandler
  mainWindow.on('closed', () => {
    // Late old-window close must not remove the replacement handler.
    if (activePrepareHandler === prepareHandler) {
      ipcMain.removeHandler(prepareChannel)
      activePrepareHandler = undefined
    }
  })
}

let activePrepareHandler: unknown

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
