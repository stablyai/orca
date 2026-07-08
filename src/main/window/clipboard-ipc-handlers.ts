import {
  app,
  clipboard,
  ipcMain,
  nativeImage,
  type IpcMainInvokeEvent,
  type WebContents
} from 'electron'
import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import type { Store } from '../persistence'
import { isENOENT, PATH_ACCESS_DENIED_MESSAGE, resolveAuthorizedPath } from '../ipc/filesystem-auth'
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
import { readClipboardFilePaths, type ClipboardFileReadDeps } from './clipboard-file-read'
import {
  cleanupExpiredRemoteClipboardFiles,
  writeRemoteFileToClipboard
} from './clipboard-remote-file-copy'
import { saveClipboardImageBufferInRuntime } from './clipboard-runtime-image-upload'

let trustedClipboardRendererWebContentsId: number | null = null

type ClipboardWriteFileRequest = {
  filePath: string
  connectionId?: string
}

async function saveClipboardImageBufferForTarget(
  buffer: Buffer,
  args?: SaveClipboardImageAsTempFileArgs
): Promise<string> {
  assertClipboardImageByteLengthWithinLimit(buffer.byteLength)
  const runtimeEnvironmentId = args?.runtimeEnvironmentId?.trim()
  if (runtimeEnvironmentId && !args?.connectionId) {
    return saveClipboardImageBufferInRuntime(app.getPath('userData'), runtimeEnvironmentId, buffer)
  }
  return saveClipboardImageBufferAsTempFile(buffer, args)
}

export function setTrustedClipboardRendererWebContentsId(webContentsId: number | null): void {
  trustedClipboardRendererWebContentsId = webContentsId
}

// Run a short-lived OS clipboard helper (PowerShell / wl-copy / xclip), feeding
// it stdin when provided; resolves only on a clean exit.
function runCommand(command: string, args: string[], stdin?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'ignore', 'ignore'] })
    child.on('error', reject)
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`))
    )
    child.stdin?.end(stdin ?? '')
  })
}

// Like runCommand, but captures stdout — the read path needs the helper's
// output (e.g. PowerShell's newline-separated file paths). Resolves only on a
// clean exit so callers can treat any failure as "no file on the clipboard".
function runCommandForOutput(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] })
    let stdout = ''
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString('utf8')
    })
    child.on('error', reject)
    child.on('exit', (code) =>
      code === 0 ? resolve(stdout) : reject(new Error(`${command} exited with ${code}`))
    )
  })
}

export function registerClipboardHandlers(store: Store): void {
  ipcMain.removeHandler('clipboard:readText')
  ipcMain.removeHandler('clipboard:readSelectionText')
  ipcMain.removeHandler('clipboard:writeText')
  ipcMain.removeHandler('clipboard:writeSelectionText')
  ipcMain.removeHandler('clipboard:writeImage')
  ipcMain.removeHandler('clipboard:writeFile')
  ipcMain.removeHandler('clipboard:readFilePaths')
  ipcMain.removeHandler('clipboard:saveImageAsTempFile')

  void cleanupExpiredRemoteClipboardFiles()

  ipcMain.handle('clipboard:readText', async (event, options?: ReadClipboardTextOptions) => {
    assertTrustedClipboardSender(event)
    return assertClipboardTextWithinLimitWithYield(clipboard.readText(), options)
  })
  ipcMain.handle(
    'clipboard:readSelectionText',
    async (event, options?: ReadClipboardTextOptions) => {
      assertTrustedClipboardSender(event)
      return assertClipboardTextWithinLimitWithYield(clipboard.readText('selection'), options)
    }
  )
  // Why: terminals need to detect clipboard images to support tools like Claude
  // Code that accept image input via paste. Writes the clipboard image to a
  // temp file and returns the path, or null if the clipboard has no image.
  ipcMain.handle(
    'clipboard:saveImageAsTempFile',
    async (event, args?: SaveClipboardImageAsTempFileArgs) => {
      assertTrustedClipboardSender(event)
      const image = clipboard.readImage()
      if (image.isEmpty()) {
        return null
      }
      assertClipboardImageDimensionsWithinLimit(image.getSize())
      return saveClipboardImageBufferForTarget(image.toPNG(), args)
    }
  )
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
      const deps = makeClipboardFileDeps(async (path) => {
        try {
          const authorizedPath = await resolveAuthorizedPath(path, store)
          await stat(authorizedPath)
          return { ok: true, path: authorizedPath }
        } catch (error) {
          if (error instanceof Error && error.message === PATH_ACCESS_DENIED_MESSAGE) {
            return { ok: false, reason: 'access-denied' }
          }
          return { ok: false, reason: isENOENT(error) ? 'not-found' : 'invalid-path' }
        }
      })
      if (request.connectionId) {
        return writeRemoteFileToClipboard({
          remotePath: request.filePath,
          connectionId: request.connectionId,
          deps
        })
      }
      return writeFileToClipboard(request.filePath, deps)
    }
  )
  // Why: a file OS-copied in Finder/Explorer/a file manager should paste its
  // full shell-escaped path into a terminal (like a drop), not the display name
  // the OS synthesizes as clipboard text. Returns the copied files' absolute
  // paths, or [] when the clipboard holds no file reference. These are paths the
  // user themselves copied, so no path-authorization is applied.
  ipcMain.handle('clipboard:readFilePaths', (event): Promise<string[]> => {
    assertTrustedClipboardSender(event)
    return readClipboardFilePaths(makeClipboardFileReadDeps())
  })
  ipcMain.handle('clipboard:writeText', async (event, text: string) => {
    assertTrustedClipboardSender(event)
    return clipboard.writeText(await assertClipboardTextWriteWithinLimitWithYield(text))
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
    // Why: only accept validated PNG data URIs to prevent writing arbitrary
    // data to the clipboard. The renderer already validates the prefix, but
    // defense-in-depth applies here too.
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
    // Why: use createFromBuffer instead of createFromDataURL — the latter
    // silently returns an empty image on some macOS + Electron combinations
    // when the data URL is large (>500KB). Decoding the base64 manually and
    // using createFromBuffer is more reliable.
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

function makeClipboardFileDeps(
  resolveFilePath: ClipboardFileDeps['resolveFilePath']
): ClipboardFileDeps {
  return {
    platform: process.platform,
    desktop: process.env.XDG_CURRENT_DESKTOP,
    resolveFilePath,
    writeBuffer: (format, buffer) => clipboard.writeBuffer(format, buffer),
    runCommand
  }
}

function makeClipboardFileReadDeps(): ClipboardFileReadDeps {
  return {
    platform: process.platform,
    desktop: process.env.XDG_CURRENT_DESKTOP,
    readFormat: (format) => clipboard.read(format),
    readBuffer: (format) => clipboard.readBuffer(format),
    runCommand: runCommandForOutput
  }
}

function assertTrustedClipboardSender(event: IpcMainInvokeEvent): void {
  if (!isTrustedClipboardRenderer(event.sender)) {
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
