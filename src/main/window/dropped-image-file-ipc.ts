import { app, ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { Store } from '../persistence'
import { resolveLocalRequestPath } from '../ipc/local-file-access-resolution'
import { saveDroppedImageFileInRuntime } from './dropped-image-runtime-upload'
import { isTrustedClipboardRenderer } from './clipboard-trust'

type SaveImageFileRequest = {
  filePath: string
  runtimeEnvironmentId: string
}

function normalizeSaveImageFileRequest(args: unknown): SaveImageFileRequest | null {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return null
  }
  const filePath = (args as { filePath?: unknown }).filePath
  const runtimeEnvironmentId = (args as { runtimeEnvironmentId?: unknown }).runtimeEnvironmentId
  if (
    typeof filePath !== 'string' ||
    filePath === '' ||
    typeof runtimeEnvironmentId !== 'string' ||
    runtimeEnvironmentId.trim() === ''
  ) {
    return null
  }
  return { filePath, runtimeEnvironmentId }
}

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  if (!isTrustedClipboardRenderer(event.sender)) {
    throw new Error('Unauthorized clipboard IPC sender')
  }
}

// Why: a file dropped onto a remote terminal chat would otherwise be refused —
// the agent can't read this machine's paths. Uploading the bytes through the
// same runtime temp pipeline a remote clipboard paste uses gives it a path it
// can read, with no orcad change.
export function registerDroppedImageFileHandlers(store: Store): void {
  ipcMain.removeHandler('clipboard:saveImageFileAsTempFile')
  ipcMain.handle(
    'clipboard:saveImageFileAsTempFile',
    async (event, args: unknown): Promise<string> => {
      assertTrustedSender(event)
      const request = normalizeSaveImageFileRequest(args)
      if (!request) {
        throw new Error('Invalid image file upload request')
      }
      // Why chat-image, not the desktop roots check: a dropped photo is named by
      // an explicit user gesture, like a transcript image, so it reads where it
      // is — the roots check refused legitimate photos outside the project.
      const authorizedPath = await resolveLocalRequestPath(
        request.filePath,
        { kind: 'chat-image' },
        store,
        'read'
      )
      return saveDroppedImageFileInRuntime(
        app.getPath('userData'),
        request.runtimeEnvironmentId,
        authorizedPath
      )
    }
  )
}

export function unregisterDroppedImageFileHandlers(): void {
  ipcMain.removeHandler('clipboard:saveImageFileAsTempFile')
}
