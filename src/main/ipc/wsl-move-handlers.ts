/**
 * IPC for the renderer half of a committed WSL move's desktop rewrite. Both channels answer
 * empty / refuse while the internal WSL hosts gate is closed.
 */
import { ipcMain, type WebContents } from 'electron'
import type {
  WslMovePendingRendererRewrite,
  WslMoveRecordStoreRewrittenResult
} from '../../shared/wsl-move/wsl-move-renderer-rewrite-types'
import {
  listPendingWslMoveRendererRewrites,
  recordWslMoveRendererStoreRewritten
} from '../persistence/moving-wsl-projects/wsl-move-desktop-rewrite'

export const WSL_MOVE_HANDLER_CHANNELS = [
  'wslMove:listPendingRendererRewrites',
  'wslMove:recordStoreRewritten'
] as const

type RendererEvent = { sender?: Pick<WebContents, 'id' | 'session'> }

export function registerWslMoveHandlers(
  getUserDataPath: () => string,
  /** The renderer stores live in the main window's storage; another window's copy is not them. */
  isMainWindowRenderer: (senderId: number) => boolean
): void {
  for (const channel of WSL_MOVE_HANDLER_CHANNELS) {
    ipcMain.removeHandler(channel)
  }
  ipcMain.handle('wslMove:listPendingRendererRewrites', (): WslMovePendingRendererRewrite[] =>
    listPendingWslMoveRendererRewrites(getUserDataPath())
  )
  ipcMain.handle(
    'wslMove:recordStoreRewritten',
    (event: RendererEvent, request: unknown): WslMoveRecordStoreRewrittenResult => {
      // Renderer input: anything but two strings is an unknown store.
      if (
        typeof request !== 'object' ||
        request === null ||
        !('migrationId' in request) ||
        !('storeId' in request) ||
        typeof request.migrationId !== 'string' ||
        typeof request.storeId !== 'string'
      ) {
        return { recorded: false, reason: 'unknown-store' }
      }
      const sender = event.sender
      if (!sender || !isMainWindowRenderer(sender.id)) {
        return { recorded: false, reason: 'not-main-window' }
      }
      return recordWslMoveRendererStoreRewritten(
        getUserDataPath(),
        { migrationId: request.migrationId, storeId: request.storeId },
        () => sender.session.flushStorageData()
      )
    }
  )
}
