import { clipboardFormatReader, writeClipboardBuffer, writeClipboardPng } from './clipboard-formats'
import {
  app,
  clipboard,
  ipcMain,
  nativeImage,
  type IpcMainInvokeEvent,
  type NativeImage,
  type WebContents
} from 'electron'
import { randomUUID } from 'node:crypto'
import { open, stat } from 'node:fs/promises'
import { runProcess } from '@orca/process-host'
import type { Store } from '../persistence'
import { PATH_ACCESS_DENIED_MESSAGE } from '../ipc/filesystem-auth'
import { resolveDesktopAuthorizedPath } from '../ipc/local-file-access-resolution'
import { isENOENT } from '../ipc/filesystem-path-containment'
import {
  assertClipboardTextWriteWithinLimitWithYield,
  assertClipboardTextWithinLimitWithYield,
  type ReadClipboardTextOptions
} from '../../shared/clipboard-text'
import {
  saveClipboardImageBufferAsTempFile,
  type SaveClipboardImageAsTempFileArgs
} from './clipboard-image-temp-file'
import {
  assertClipboardImageBase64LengthWithinLimit,
  assertClipboardImageByteLengthWithinLimit,
  assertClipboardImageDimensionsWithinLimit
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
import { saveClipboardImageBufferInRuntime } from './clipboard-runtime-image-upload'
import { uploadPasteToAgentSessionAttachments } from '../ipc/agent-session-attachment-upload'
import { readWindowsClipboardImageFileAsPng } from './clipboard-windows-image-file'
import { readClipboardImageSource } from './clipboard-image-source'
import { readClipboardCopiedFilePaths } from './clipboard-copied-file-paths'
import { buildClipboardImageThumbnail } from './clipboard-image-thumbnail'
import { readClipboardNativeImage } from './clipboard-native-image'
import { publishClipboardText } from './clipboard-text-publisher'
import { isDashboardPopoutRenderer } from './dashboard-popout-window'
import { restoreNativeChatPastes } from './native-chat-paste-files'
import { savePastedTextAsFile, type SavePastedTextAsFileArgs } from './native-chat-pasted-text-file'
import { agentSessionPastedImageName } from '../../shared/agent-session-attachments'
import type { AgentSessionAttachmentStore } from '../native-chat/agent-session-attachments/agent-session-attachment-store'

let trustedClipboardRendererWebContentsId: number | null = null

type ClipboardWriteFileRequest = {
  filePath: string
  connectionId?: string
}

export type ClipboardHandlerOptions = {
  /** This machine's chat attachment store, after starting its chat host; null when it can't. */
  localChatAttachmentStore?: () => Promise<AgentSessionAttachmentStore | null>
}

async function saveClipboardImageBufferForTarget(
  buffer: Buffer,
  args: SaveClipboardImageAsTempFileArgs | undefined,
  options: ClipboardHandlerOptions
): Promise<string> {
  assertClipboardImageByteLengthWithinLimit(buffer.byteLength)
  const runtimeEnvironmentId = args?.runtimeEnvironmentId?.trim()
  // A structured chat on a paired server keeps its pasted images in that server's store.
  if (runtimeEnvironmentId && args?.agentSessionAttachment) {
    return uploadPasteToAgentSessionAttachments(
      args.agentSessionAttachment,
      runtimeEnvironmentId,
      app.getPath('userData'),
      buffer
    )
  }
  // Why (#17679): with a runtime owner, a connectionId names one of the RUNTIME's SSH
  // connections (nested Remote Server -> SSH), not one this process dialed. Looking it up
  // in the local provider registry can only miss, so the runtime must perform the save.
  if (runtimeEnvironmentId) {
    return saveClipboardImageBufferInRuntime(
      app.getPath('userData'),
      runtimeEnvironmentId,
      buffer,
      args?.connectionId ?? null
    )
  }
  // A local structured chat's paste goes in this machine's chat store: a send claims it for its
  // chat, and only an unclaimed one is ever swept. Any other composer paste keeps the paste folder.
  if (args?.forNativeChatDraft === true && args.forStructuredChat === true && !args.connectionId) {
    const store = await options.localChatAttachmentStore?.().catch(() => null)
    if (store) {
      return store.storeFile(agentSessionPastedImageName(Date.now(), randomUUID()), buffer)
    }
  }
  return saveClipboardImageBufferAsTempFile(buffer, args)
}

export function setTrustedClipboardRendererWebContentsId(webContentsId: number | null): void {
  trustedClipboardRendererWebContentsId = webContentsId
}

export function registerClipboardHandlers(
  store: Store,
  handlerOptions: ClipboardHandlerOptions = {}
): void {
  ipcMain.removeHandler('clipboard:readText')
  ipcMain.removeHandler('clipboard:readSelectionText')
  ipcMain.removeHandler('clipboard:writeText')
  ipcMain.removeHandler('clipboard:writeTerminalText')
  ipcMain.removeHandler('clipboard:writeSelectionText')
  ipcMain.removeHandler('clipboard:writeImage')
  ipcMain.removeHandler('clipboard:writeFile')
  ipcMain.removeHandler('clipboard:saveImageAsTempFile')
  ipcMain.removeHandler('clipboard:savePastedTextAsFile')
  ipcMain.removeHandler('clipboard:readImageThumbnail')
  ipcMain.removeHandler('clipboard:hasImage')
  ipcMain.removeHandler('clipboard:readFilePaths')
  ipcMain.removeHandler('clipboard:restoreNativeChatPastes')

  void cleanupExpiredRemoteClipboardFiles()
  scheduleLegacyRemoteClipboardFileCleanup()

  ipcMain.handle('clipboard:readText', async (event, options?: ReadClipboardTextOptions) => {
    assertTrustedClipboardTextSender(event)
    return assertClipboardTextWithinLimitWithYield(await clipboard.readText(), options)
  })
  ipcMain.handle(
    'clipboard:readSelectionText',
    async (event, options?: ReadClipboardTextOptions) => {
      assertTrustedClipboardSender(event)
      return assertClipboardTextWithinLimitWithYield(
        process.platform === 'linux' ? await clipboard.selection.readText() : '',
        options
      )
    }
  )
  ipcMain.handle('clipboard:restoreNativeChatPastes', (event, paths: unknown) => {
    assertTrustedClipboardSender(event)
    return restoreNativeChatPastes(paths)
  })
  // Why: an unanswered paste reads as a dropped paste, so the composer probes
  // the clipboard in memory before the (slower) save lands.
  ipcMain.handle('clipboard:readImageThumbnail', async (event) => {
    assertTrustedClipboardSender(event)
    try {
      return buildClipboardImageThumbnail(await readClipboardNativeImage())
    } catch {
      // The save call reports rejected source data; the preview is best effort.
      return null
    }
  })
  ipcMain.handle('clipboard:hasImage', async (event): Promise<boolean> => {
    assertTrustedClipboardSender(event)
    return (await readClipboardImageSource(clipboardFormatReader)) !== null
  })
  // Why: a file-manager copy also carries the files' names as text, which a paste must not type.
  ipcMain.handle('clipboard:readFilePaths', async (event): Promise<string[]> => {
    assertTrustedClipboardSender(event)
    return readClipboardCopiedFilePaths(clipboardFormatReader)
  })
  // Why: terminals need to detect clipboard images to support tools like Claude
  // Code that accept image input via paste. Writes the clipboard image to a
  // temp file and returns the path, or null if the clipboard has no image.
  ipcMain.handle(
    'clipboard:saveImageAsTempFile',
    async (event, args?: SaveClipboardImageAsTempFileArgs) => {
      assertTrustedClipboardSender(event)
      const source = await readClipboardImageSource(clipboardFormatReader)
      if (!source) {
        return null
      }
      const image = await readClipboardNativeImage()
      if (image.isEmpty()) {
        if (!source.windowsFileFormats) {
          return null
        }
        const copiedFilePng = await readWindowsClipboardImageFileAsPng(source.windowsFileFormats, {
          createImageFromBuffer: (buffer) => nativeImage.createFromBuffer(buffer),
          openFile: (filePath) => open(filePath, 'r')
        })
        return copiedFilePng
          ? saveClipboardImageBufferForTarget(copiedFilePng, args, handlerOptions)
          : null
      }
      assertClipboardImageDimensionsWithinLimit(image.getSize())
      return saveClipboardImageBufferForTarget(image.toPNG(), args, handlerOptions)
    }
  )
  ipcMain.handle('clipboard:savePastedTextAsFile', (event, args: SavePastedTextAsFileArgs) => {
    assertTrustedClipboardSender(event)
    return savePastedTextAsFile(args, handlerOptions.localChatAttachmentStore)
  })
  // Why: copy the actual file to the OS clipboard so pasting in Finder/Explorer
  // drops the file itself, not its path as text.
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
      return writeFileToClipboard(request.filePath, {
        platform: process.platform,
        desktop: process.env.XDG_CURRENT_DESKTOP,
        resolveFilePath,
        writeBuffer: writeClipboardBuffer,
        runProcess
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
    const safeText = await assertClipboardTextWriteWithinLimitWithYield(text)
    if (process.platform === 'linux') {
      await clipboard.selection.writeText(safeText)
    }
  })
  ipcMain.handle('clipboard:writeImage', async (event, dataUrl: string) => {
    assertTrustedClipboardSender(event)
    // Validate here too: renderer checks do not authorize arbitrary clipboard formats.
    const prefix = 'data:image/png;base64,'
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith(prefix)) {
      return
    }
    const contentBase64 = dataUrl.slice(prefix.length)
    let image: NativeImage
    try {
      assertClipboardImageBase64LengthWithinLimit(contentBase64.length)
      const buffer = Buffer.from(contentBase64, 'base64')
      assertClipboardImageByteLengthWithinLimit(buffer.byteLength)
      // createFromDataURL can silently reject large images on macOS.
      image = nativeImage.createFromBuffer(buffer)
      if (image.isEmpty()) {
        return
      }
      assertClipboardImageDimensionsWithinLimit(image.getSize())
    } catch {
      return
    }
    await writeClipboardPng(image.toPNG())
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
  // Why: terminal copy/paste runs in the exact dashboard popout window, but its
  // clipboard authority must not extend to image, file, or remote operations.
  if (!isTrustedClipboardRenderer(event.sender) && !isDashboardPopoutRenderer(event.sender)) {
    throw new Error('Unauthorized clipboard IPC sender')
  }
}

function isTrustedClipboardRenderer(sender: WebContents): boolean {
  if (sender.isDestroyed() || sender.getType() !== 'window') {
    return false
  }
  if (trustedClipboardRendererWebContentsId != null) {
    return sender.id === trustedClipboardRendererWebContentsId
  }

  const senderUrl = sender.getURL()
  if (process.env.ELECTRON_RENDERER_URL) {
    try {
      return new URL(senderUrl).origin === new URL(process.env.ELECTRON_RENDERER_URL).origin
    } catch {
      return false
    }
  }

  return senderUrl.startsWith('file://')
}
