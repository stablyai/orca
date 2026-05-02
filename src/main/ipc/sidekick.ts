import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { copyFile, mkdir, readFile, rm, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, extname, join, normalize, sep } from 'node:path'
import type { CustomSidekick } from '../../shared/types'

// Why: image-only sidekick uploads. Static + animated variants render natively
// via <img>, so no 3D engine is needed. Main owns the accepted-format table as
// the single source of truth for what the renderer will try to display.
const IMAGE_FORMATS: Record<string, string> = {
  '.png': 'image/png',
  '.apng': 'image/apng',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml'
}

function classifyFile(src: string): { mimeType: string; ext: string } | null {
  const ext = extname(src).toLowerCase()
  const mime = IMAGE_FORMATS[ext]
  if (!mime) {
    return null
  }
  return { mimeType: mime, ext }
}

// Why: custom user-uploaded images live in a dedicated folder under userData
// so they persist across updates but are scoped to the Orca install. We never
// trust paths the renderer hands us — the renderer only ever knows the opaque
// CustomSidekick.id; main resolves it to an absolute path inside this folder.
function getSidekicksDir(): string {
  return join(app.getPath('userData'), 'sidekicks', 'custom')
}

const MAX_BYTES = 64 * 1024 * 1024 // 64 MB — generous but bounded so a user can't point at a multi-GB file and OOM the renderer when it builds a Blob URL.

function isSafeId(id: string): boolean {
  // UUIDs only; blocks path traversal and unexpected characters.
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
}

function resolveSidekickFile(id: string, fileName: string): string | null {
  if (!isSafeId(id)) {
    return null
  }
  // Why: the renderer hands back the persisted fileName (which includes the
  // original extension so Blob MIME detection works). We still normalize and
  // prefix-check against the sidekicks dir to defend against any edge case that
  // slipped the id regex.
  const safeName = basename(fileName)
  if (!safeName.startsWith(`${id}.`)) {
    return null
  }
  const filePath = normalize(join(getSidekicksDir(), safeName))
  if (!filePath.startsWith(normalize(getSidekicksDir()) + sep)) {
    return null
  }
  return filePath
}

export function registerSidekickHandlers(): void {
  ipcMain.handle('sidekick:import', async (event): Promise<CustomSidekick | null> => {
    // Why: parent the file picker to the sender window so the dialog opens as
    // a sheet attached to the main window. Without a parent, on macOS the
    // dialog can land behind the main window.
    const senderWindow =
      BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow()
    const options: Electron.OpenDialogOptions = {
      title: 'Pick sidekick',
      properties: ['openFile'],
      // Why: single filter and no `apng` extension. macOS file dialogs map
      // filter extensions to UTIs; `apng` has no registered UTI, so including
      // it can drop sibling extensions (notably `webp`) from the allowed set.
      // APNG files carry the `.png` extension and are detected from magic
      // bytes by the browser.
      filters: [
        {
          name: 'Sidekick image',
          extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']
        }
      ]
    }
    const result = senderWindow
      ? await dialog.showOpenDialog(senderWindow, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) {
      return null
    }
    const src = result.filePaths[0]
    const classified = classifyFile(src)
    if (!classified) {
      throw new Error('Unsupported file. Pick a PNG, APNG, JPG, GIF, WebP, or SVG.')
    }
    let srcStat: Awaited<ReturnType<typeof stat>>
    try {
      srcStat = await stat(src)
    } catch {
      throw new Error('Could not read the selected file.')
    }
    if (!srcStat.isFile()) {
      throw new Error('Selected path is not a file')
    }
    if (srcStat.size > MAX_BYTES) {
      throw new Error(
        `File is too large (${(srcStat.size / (1024 * 1024)).toFixed(1)} MB). Max is ${MAX_BYTES / (1024 * 1024)} MB.`
      )
    }

    const dir = getSidekicksDir()
    await mkdir(dir, { recursive: true })
    const id = randomUUID()
    // Why: preserve original extension in the on-disk name so sidekick:read can
    // rebuild the right Blob MIME via resolveSidekickFile without a separate
    // lookup. The extension is only ever written by main (never the renderer).
    const fileName = `${id}${classified.ext}`
    const dest = join(dir, fileName)
    try {
      await copyFile(src, dest)
    } catch {
      await rm(dest, { force: true }).catch(() => {})
      throw new Error('Could not save the sidekick.')
    }

    const rawLabel = basename(src, extname(src)).trim()
    const label = rawLabel.length > 0 ? rawLabel.slice(0, 40) : 'Custom sidekick'
    return {
      id,
      label,
      fileName,
      mimeType: classified.mimeType
    }
  })

  ipcMain.handle(
    'sidekick:read',
    async (_event, id: string, fileName: string): Promise<ArrayBuffer | null> => {
      const filePath = resolveSidekickFile(id, fileName)
      if (!filePath) {
        return null
      }
      try {
        const buf = await readFile(filePath)
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
      } catch (error) {
        console.warn('[sidekick-overlay] sidekick:read failed', error)
        return null
      }
    }
  )

  ipcMain.handle('sidekick:delete', async (_event, id: string, fileName: string): Promise<void> => {
    const filePath = resolveSidekickFile(id, fileName)
    if (!filePath) {
      return
    }
    try {
      await rm(filePath, { force: true })
    } catch (error) {
      console.warn('[sidekick-overlay] sidekick:delete failed', error)
    }
  })
}
