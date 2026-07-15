import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { copyFile, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, extname, join, normalize, sep } from 'node:path'
import { z } from 'zod'
import {
  backgroundImageFileMime,
  isBackgroundImageStorageId,
  normalizeBackgroundImageLabel,
  TERMINAL_BACKGROUND_IMAGE_FORMATS,
  type TerminalBackgroundImage
} from '../../shared/terminal-background-image'

// Why: main reads only the current background reference so it can prune stale
// files at startup. Kept narrow to avoid importing the full Store type here.
type TerminalBackgroundStore = {
  getSettings: () => { terminalBackgroundImage?: { fileName?: string } | null }
}

/** Classify a picked source file by extension against the image allowlist,
 *  returning its MIME + extension, or null when the type is not supported. */
function classifyFile(src: string): { mimeType: string; ext: string } | null {
  const ext = extname(src).toLowerCase()
  const mime = TERMINAL_BACKGROUND_IMAGE_FORMATS[ext]
  if (!mime) {
    return null
  }
  return { mimeType: mime, ext }
}

/** Absolute path to the per-user background-image store under userData. */
function getTerminalBackgroundsDir(): string {
  return join(app.getPath('userData'), 'terminal-backgrounds')
}

// 64 MB — generous but bounded so a user can't point at a multi-GB file and
// OOM the renderer when it builds a Blob URL. Same bound as custom pets.
const MAX_BYTES = 64 * 1024 * 1024

/** Resolve a stored image path from an untrusted (id, fileName) pair, or null
 *  when it fails the shared id + extension allowlist or directory-containment
 *  gate. The single trusted resolver for both read and delete. */
function resolveTerminalBackgroundFile(id: string, fileName: string): string | null {
  // Why: gate on the shared id + allowlisted-extension check so read/delete can
  // only touch `${id}.<allowed-ext>` — the picker enforces the same allowlist,
  // and this stops a renderer from reading/deleting `<id>.json` etc. that may
  // sit in the backgrounds dir.
  if (!backgroundImageFileMime(id, fileName)) {
    return null
  }
  const safeName = basename(fileName)
  const root = normalize(getTerminalBackgroundsDir())
  const filePath = normalize(join(root, safeName))
  // Defense in depth: the checks above already exclude separators, but keep the
  // prefix guard so any future change to the id/name shape can't escape the dir.
  if (!filePath.startsWith(root + sep)) {
    return null
  }
  return filePath
}

// Why: renderer-supplied IPC inputs are untrusted — validate shape before any
// path resolution. resolveTerminalBackgroundFile still gates the actual path.
const TerminalBackgroundFileRequestSchema = z.object({
  id: z.string(),
  fileName: z.string()
})

// Why: a crash or dropped delete IPC between saving a replacement and cleaning
// up the previous file would orphan it forever. Prune everything in the dir that
// isn't the currently-referenced file at startup so disk use can't grow unbounded.
// Called from the startup sequence, separately from handler registration.
export async function pruneOrphanTerminalBackgrounds(
  store: TerminalBackgroundStore
): Promise<void> {
  const keepFileName = store.getSettings().terminalBackgroundImage?.fileName ?? null
  const dir = getTerminalBackgroundsDir()
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return
  }
  await Promise.all(
    entries
      .filter((name) => name !== keepFileName)
      .map((name) => rm(join(dir, name), { force: true }).catch(() => {}))
  )
}

/** Register the pick/read/delete IPC handlers for terminal background images. */
export function registerTerminalBackgroundHandlers(store: TerminalBackgroundStore): void {
  ipcMain.handle(
    'terminalBackground:pick',
    async (event): Promise<TerminalBackgroundImage | null> => {
      const senderWindow =
        BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow()
      const options: Electron.OpenDialogOptions = {
        title: 'Pick background image',
        properties: ['openFile'],
        filters: [
          {
            name: 'Background image',
            extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp']
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
        throw new Error('Unsupported file. Pick a PNG, JPG, GIF, or WebP.')
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

      const dir = getTerminalBackgroundsDir()
      await mkdir(dir, { recursive: true })
      const id = randomUUID()
      // Why: preserve original extension in the on-disk name so
      // terminalBackground:read can rebuild the right Blob MIME via
      // resolveTerminalBackgroundFile without a separate lookup.
      const fileName = `${id}${classified.ext}`
      const dest = join(dir, fileName)
      try {
        await copyFile(src, dest)
      } catch {
        await rm(dest, { force: true }).catch(() => {})
        throw new Error('Could not save the background image.')
      }

      const label = normalizeBackgroundImageLabel(basename(src, extname(src)))
      return {
        id,
        fileName,
        mimeType: classified.mimeType,
        ...(label ? { label } : {})
      }
    }
  )

  ipcMain.handle(
    'terminalBackground:read',
    async (_event, id: string, fileName: string): Promise<ArrayBuffer | null> => {
      let parsed: z.infer<typeof TerminalBackgroundFileRequestSchema>
      try {
        parsed = TerminalBackgroundFileRequestSchema.parse({ id, fileName })
      } catch {
        throw new Error('Invalid terminalBackground:read arguments')
      }
      const filePath = resolveTerminalBackgroundFile(parsed.id, parsed.fileName)
      if (!filePath) {
        return null
      }
      try {
        const buf = await readFile(filePath)
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
      } catch (error) {
        console.warn('[terminal-background] terminalBackground:read failed', error)
        return null
      }
    }
  )

  ipcMain.handle(
    'terminalBackground:delete',
    async (_event, id: string, fileName: string): Promise<void> => {
      let parsed: z.infer<typeof TerminalBackgroundFileRequestSchema>
      try {
        parsed = TerminalBackgroundFileRequestSchema.parse({ id, fileName })
      } catch {
        throw new Error('Invalid terminalBackground:delete arguments')
      }
      // Why: never delete the file that is still the active background — guards
      // against a stale delete IPC (from a superseded replace) removing the
      // live image.
      if (isBackgroundImageStorageId(parsed.id)) {
        const active = store.getSettings().terminalBackgroundImage
        if (active && active.fileName === parsed.fileName) {
          return
        }
      }
      const filePath = resolveTerminalBackgroundFile(parsed.id, parsed.fileName)
      if (!filePath) {
        return
      }
      try {
        await rm(filePath, { force: true })
      } catch (error) {
        console.warn('[terminal-background] terminalBackground:delete failed', error)
      }
    }
  )
}
