import {
  clipboard,
  ipcMain,
  nativeImage,
  type IpcMainInvokeEvent,
  type WebContents
} from 'electron'
import { open, stat } from 'node:fs/promises'
import { runProcess } from '@orca/process-host'
import type { Store } from '../persistence'
import { PATH_ACCESS_DENIED_MESSAGE } from '../ipc/filesystem/filesystem-auth'
import { resolveDesktopAuthorizedPath } from '../ipc/local-file-access-resolution'
import { isENOENT } from '../ipc/filesystem/filesystem-path-containment'
import { isTrustedMainRendererSender } from '../ipc/main-renderer-sender-trust'
import {
  assertClipboardTextWriteWithinLimitWithYield,
  assertClipboardTextWithinLimitWithYield,
  type ReadClipboardTextOptions
} from '../../shared/clipboard-text'
import {
  saveClipboardImageBufferForTarget,
  type ClipboardHandlerOptions,
  type SaveClipboardImageAsTempFileArgs
} from './clipboard-image-temp-file'
export type { ClipboardHandlerOptions }
import {
  assertClipboardImageBase64LengthWithinLimit,
  assertClipboardImageByteLengthWithinLimit,
  assertClipboardImageDimensionsWithinLimit,
  type ClipboardImageThumbnail
} from '../../shared/clipboard-image'
import {
  writeFileToClipboard,
  type ClipboardFileDeps,
  type ClipboardFileResult
} from './clipboard-file-copy'
import { SshHostNotServedError } from '../providers/ssh-host-not-served-error'
import {
  cleanupExpiredRemoteClipboardFiles,
  scheduleLegacyRemoteClipboardFileCleanup
} from './clipboard-remote-file-copy'
import { readWindowsClipboardImageFileAsPng } from './clipboard-windows-image-file'
import { readClipboardImageSource } from './clipboard-image-source'
import { readClipboardCopiedFilePaths } from './clipboard-copied-file-paths'
import { buildClipboardImageThumbnail } from './clipboard-image-thumbnail'
import { readClipboardNativeImage } from './clipboard-native-image'
import {
  ClipboardPublisherBusyError,
  publishClipboardOperation,
  publishClipboardText
} from './clipboard-text-publisher'
import { isDashboardPopoutRenderer } from './dashboard-popout-window'
import { restoreNativeChatPastes } from './native-chat-paste-files'
import { savePastedTextAsFile, type SavePastedTextAsFileArgs } from './native-chat-pasted-text-file'
import {
  compressClipboardImageIfExceedsLimit,
  compressCopiedFilePngIfExceedsLimit
} from './clipboard-image-compression'

let trustedClipboardRendererWebContentsId: number | null = null

type ClipboardWriteFileRequest = {
  filePath: string
  connectionId?: string
}

export function setTrustedClipboardRendererWebContentsId(webContentsId: number | null): void {
  trustedClipboardRendererWebContentsId = webContentsId
}

export function registerClipboardHandlers(
  store: Store,
  handlerOptions: ClipboardHandlerOptions = {}
): void {
  for (const channel of [
    'clipboard:readText',
    'clipboard:readSelectionText',
    'clipboard:writeText',
    'clipboard:writeTerminalText',
    'clipboard:writeSelectionText',
    'clipboard:writeImage',
    'clipboard:writeFile',
    'clipboard:saveImageAsTempFile',
    'clipboard:savePastedTextAsFile',
    'clipboard:readImageThumbnail',
    'clipboard:hasImage',
    'clipboard:readFilePaths',
    'clipboard:restoreNativeChatPastes'
  ]) {
    ipcMain.removeHandler(channel)
  }

  void cleanupExpiredRemoteClipboardFiles()
  scheduleLegacyRemoteClipboardFileCleanup()

  ipcMain.handle('clipboard:readText', async (event, options?: ReadClipboardTextOptions) => {
    assertTrustedClipboardTextSender(event)
    return assertClipboardTextWithinLimitWithYield(clipboard.readText(), options)
  })
  ipcMain.handle(
    'clipboard:readSelectionText',
    async (event, options?: ReadClipboardTextOptions) => {
      assertTrustedClipboardSender(event)
      return assertClipboardTextWithinLimitWithYield(clipboard.readText('selection'), options)
    }
  )
  ipcMain.handle('clipboard:restoreNativeChatPastes', (event, paths: unknown) => {
    assertTrustedClipboardSender(event)
    return restoreNativeChatPastes(paths)
  })
  // Preview in memory so the composer responds before the slower save completes.
  ipcMain.handle('clipboard:readImageThumbnail', (event): ClipboardImageThumbnail | null => {
    assertTrustedClipboardSender(event)
    try {
      return buildClipboardImageThumbnail(readClipboardNativeImage())
    } catch {
      // The save call reports rejected source data; the preview is best effort.
      return null
    }
  })
  ipcMain.handle('clipboard:hasImage', (event): boolean => {
    assertTrustedClipboardSender(event)
    return readClipboardImageSource(clipboard) !== null
  })
  // File-manager copies include text labels that paste must not type.
  ipcMain.handle('clipboard:readFilePaths', (event): string[] => {
    assertTrustedClipboardSender(event)
    return readClipboardCopiedFilePaths(clipboard)
  })
  // Give image-aware terminal tools a saved image path, or null when no image exists.
  ipcMain.handle(
    'clipboard:saveImageAsTempFile',
    async (event, args?: SaveClipboardImageAsTempFileArgs) => {
      assertTrustedClipboardSender(event)
      const source = readClipboardImageSource(clipboard)
      if (!source) {
        return null
      }
      const image = readClipboardNativeImage()
      if (image.isEmpty()) {
        if (!source.windowsFileFormats) {
          return null
        }
        const copiedFilePng = await readWindowsClipboardImageFileAsPng(source.windowsFileFormats, {
          createImageFromBuffer: (buffer) => nativeImage.createFromBuffer(buffer),
          openFile: (filePath) => open(filePath, 'r')
        })
        return copiedFilePng
          ? saveClipboardImageBufferForTarget(
              compressCopiedFilePngIfExceedsLimit(copiedFilePng, nativeImage.createFromBuffer),
              args,
              handlerOptions
            )
          : null
      }
      assertClipboardImageDimensionsWithinLimit(image.getSize())
      return saveClipboardImageBufferForTarget(
        compressClipboardImageIfExceedsLimit(image),
        args,
        handlerOptions
      )
    }
  )
  ipcMain.handle('clipboard:savePastedTextAsFile', (event, args: SavePastedTextAsFileArgs) => {
    assertTrustedClipboardSender(event)
    return savePastedTextAsFile(args, handlerOptions.localChatAttachmentStore)
  })
  // Publish OS file references for Finder/Explorer paste.
  ipcMain.handle(
    'clipboard:writeFile',
    (event, args: unknown): ClipboardFileResult | Promise<ClipboardFileResult> => {
      assertTrustedClipboardSender(event)
      const request = normalizeClipboardWriteFileRequest(args)
      if (!request) {
        return { ok: false, reason: 'invalid-path' }
      }
      if (request.connectionId) {
        throw new SshHostNotServedError(request.connectionId)
      }
      const resolveFilePath: ClipboardFileDeps['resolveFilePath'] = async (path) => {
        try {
          const authorizedPath = await resolveDesktopAuthorizedPath(path, store)
          await stat(authorizedPath)
          return { ok: true, path: authorizedPath }
        } catch (error) {
          if (error instanceof Error && error.message === PATH_ACCESS_DENIED_MESSAGE) {
            return { ok: false, reason: 'access-denied' }
          }
          return { ok: false, reason: isENOENT(error) ? 'not-found' : 'invalid-path' }
        }
      }
      return publishClipboardOperation(request.filePath.length * 2, () =>
        writeFileToClipboard(request.filePath, {
          platform: process.platform,
          desktop: process.env.XDG_CURRENT_DESKTOP,
          resolveFilePath,
          writeBuffer: (format, buffer) => clipboard.writeBuffer(format, buffer),
          runProcess
        })
      ).catch((error: unknown) => {
        if (error instanceof ClipboardPublisherBusyError) {
          return { ok: false, reason: 'clipboard-busy' }
        }
        throw error
      })
    }
  )
  ipcMain.handle('clipboard:writeText', async (event, text: string) => {
    assertTrustedClipboardTextSender(event)
    try {
      await publishClipboardText(text, 'ordinary')
    } catch (error) {
      // Native failures can name paths or platform state, so they stay here; the renderer
      // only renders a vetted reason (describeClipboardWriteFailure).
      console.error('[clipboard] writeText failed', error)
      throw error
    }
  })
  ipcMain.handle('clipboard:writeTerminalText', async (event, text: string) => {
    assertTrustedClipboardTextSender(event)
    return publishClipboardText(text)
  })
  ipcMain.handle('clipboard:writeSelectionText', async (event, text: string) => {
    assertTrustedClipboardSender(event)
    return clipboard.writeText(
      await assertClipboardTextWriteWithinLimitWithYield(text),
      'selection'
    )
  })
  ipcMain.handle('clipboard:writeImage', (event, dataUrl: string) => {
    assertTrustedClipboardSender(event)
    // Validate PNG data URIs in main too; renderer checks cannot constrain direct IPC.
    const prefix = 'data:image/png;base64,'
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith(prefix)) {
      return
    }
    const contentBase64 = dataUrl.slice(prefix.length)
    try {
      assertClipboardImageBase64LengthWithinLimit(contentBase64.length)
    } catch {
      return
    }
    return publishClipboardOperation(contentBase64.length * 2, () => {
      // createFromDataURL silently fails on large images in some macOS/Electron versions; decode base64 then use createFromBuffer.
      const buffer = Buffer.from(contentBase64, 'base64')
      try {
        assertClipboardImageByteLengthWithinLimit(buffer.byteLength)
      } catch {
        return
      }
      const image = nativeImage.createFromBuffer(buffer)
      if (image.isEmpty()) {
        return
      }
      try {
        assertClipboardImageDimensionsWithinLimit(image.getSize())
      } catch {
        return
      }
      clipboard.writeImage(image)
    })
  })
}

function normalizeClipboardWriteFileRequest(args: unknown): ClipboardWriteFileRequest | null {
  if (typeof args === 'string') {
    return { filePath: args }
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return null
  }
  const filePath = (args as { filePath?: unknown }).filePath
  if (typeof filePath !== 'string') {
    return null
  }
  const connectionId = (args as { connectionId?: unknown }).connectionId
  if (typeof connectionId === 'string' && connectionId.trim() !== '') {
    return { filePath, connectionId }
  }
  return { filePath }
}

function assertTrustedClipboardSender(event: IpcMainInvokeEvent): void {
  if (!isTrustedClipboardRenderer(event.sender)) {
    throw new Error('Unauthorized clipboard IPC sender')
  }
}

function assertTrustedClipboardTextSender(event: IpcMainInvokeEvent): void {
  // Dashboard popouts need text clipboard authority only; never extend it to images, files or remote operations.
  if (!isTrustedClipboardRenderer(event.sender) && !isDashboardPopoutRenderer(event.sender)) {
    throw new Error('Unauthorized clipboard IPC sender')
  }
}

function isTrustedClipboardRenderer(sender: WebContents): boolean {
  return isTrustedMainRendererSender(sender, trustedClipboardRendererWebContentsId)
}
