import { ipcMain } from 'electron'
import { registerLazyIpcHandleGroup } from '../../ipc/lazy-ipc-handle-group'
import type { ClipboardHandlerOptions } from './clipboard-ipc-handlers'

const CLIPBOARD_IPC_CHANNELS = [
  'clipboard:readText',
  'clipboard:readPasteContent',
  'clipboard:readSelectionText',
  'clipboard:writeText',
  'clipboard:writeTerminalText',
  'clipboard:writeSecretText',
  'clipboard:writeSelectionText',
  'clipboard:writeImage',
  'clipboard:writeFile',
  'clipboard:saveImageAsTempFile',
  'clipboard:savePastedTextAsFile',
  'clipboard:readImageThumbnail',
  'clipboard:hasImage',
  'clipboard:restoreNativeChatPastes'
] as const

const REMOTE_CLIPBOARD_CLEANUP_DELAY_MS = 30_000
let remoteClipboardCleanupTimer: ReturnType<typeof setTimeout> | null = null

export function registerLazyClipboardHandlers(
  authorizeLocalPath: (path: string) => Promise<string>,
  handlerOptions: ClipboardHandlerOptions = {}
): void {
  for (const channel of CLIPBOARD_IPC_CHANNELS) {
    ipcMain.removeHandler(channel)
  }
  if (!remoteClipboardCleanupTimer) {
    remoteClipboardCleanupTimer = setTimeout(() => {
      remoteClipboardCleanupTimer = null
      void import('./clipboard-remote-file-copy')
        .then(
          ({ cleanupExpiredRemoteClipboardFiles, scheduleLegacyRemoteClipboardFileCleanup }) => {
            void cleanupExpiredRemoteClipboardFiles()
            scheduleLegacyRemoteClipboardFileCleanup()
          }
        )
        .catch(() => {})
    }, REMOTE_CLIPBOARD_CLEANUP_DELAY_MS)
    remoteClipboardCleanupTimer.unref()
  }
  registerLazyIpcHandleGroup(CLIPBOARD_IPC_CHANNELS, async (ipc) => {
    const { registerClipboardHandlers } = await import('./clipboard-ipc-handlers')
    registerClipboardHandlers(authorizeLocalPath, handlerOptions, ipc)
  })
}
