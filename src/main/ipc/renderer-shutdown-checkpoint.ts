import { ipcMain } from 'electron'
import type {
  RendererShutdownCapture,
  RendererShutdownCheckpointService,
  ShutdownCheckpointResult
} from '../core-desktop/renderer-shutdown-checkpoint-service'

export function registerRendererShutdownCheckpointHandler(
  checkpoints: RendererShutdownCheckpointService
): void {
  // beforeunload cannot await; sync reply confirms staging while navigation paths separately join durability.
  let pendingCheckpoint: Promise<ShutdownCheckpointResult> = Promise.resolve({ ok: true })

  ipcMain.on('app:stage-before-unload-sync', (event, args: RendererShutdownCapture) => {
    const result = checkpoints.stage(args)
    pendingCheckpoint = result.durable
    event.returnValue = result.staged
  })

  ipcMain.handle(
    'app:await-before-unload-checkpoint',
    (): Promise<ShutdownCheckpointResult> => pendingCheckpoint
  )
}
