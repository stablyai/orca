import { BrowserWindow, dialog, ipcMain } from 'electron'
import { copyFile, mkdir, readFile, rm, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, extname, join, normalize, sep } from 'node:path'
import { z } from 'zod'
import type { CustomPet } from '../../shared/pet-types'
import { importPetBundle } from './pet-bundle-import'
import { classifyFile } from './pet-image-formats'
import { MAX_BYTES } from './pet-import-size-limits'
import { getPetsDir, isSafeId, resolvePetFile } from './pet-storage-paths'

// Why: renderer IPC inputs are untrusted — validate shape here; resolvePetFile still gates the actual filesystem path.
const PetFileRequestSchema = z.object({
  id: z.string(),
  fileName: z.string(),
  kind: z.enum(['image', 'bundle']).optional()
})

export function registerPetHandlers(): void {
  ipcMain.handle('pet:import', async (event): Promise<CustomPet | null> => {
    const senderWindow =
      BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow()
    const options: Electron.OpenDialogOptions = {
      title: 'Pick pet',
      properties: ['openFile'],
      // Why: omit `apng` — macOS maps dialog extensions to UTIs, and apng's missing UTI can drop siblings like webp (APNG uses .png anyway).
      filters: [
        {
          name: 'Pet image',
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

    const dir = getPetsDir()
    await mkdir(dir, { recursive: true })
    const id = randomUUID()
    // Why: keep the original extension in the on-disk name so pet:read can rebuild the Blob MIME without a separate lookup.
    const fileName = `${id}${classified.ext}`
    const dest = join(dir, fileName)
    try {
      await copyFile(src, dest)
    } catch {
      await rm(dest, { force: true }).catch(() => {})
      throw new Error('Could not save the pet.')
    }

    const rawLabel = basename(src, extname(src)).trim()
    const label = rawLabel.length > 0 ? rawLabel.slice(0, 40) : 'Custom pet'
    return {
      id,
      label,
      fileName,
      mimeType: classified.mimeType,
      kind: 'image'
    }
  })

  ipcMain.handle('pet:importPetBundle', async (event): Promise<CustomPet | null> =>
    importPetBundle(event)
  )

  ipcMain.handle(
    'pet:read',
    async (
      _event,
      id: string,
      fileName: string,
      kind?: 'image' | 'bundle'
    ): Promise<ArrayBuffer | null> => {
      // Why: renderer inputs are untrusted; validate shape before any path logic.
      let parsed: z.infer<typeof PetFileRequestSchema>
      try {
        parsed = PetFileRequestSchema.parse({ id, fileName, kind })
      } catch {
        throw new Error('Invalid pet:read arguments')
      }
      // Why: default 'image' for backwards compat with pre-bundle persisted state.
      const filePath = resolvePetFile(parsed.id, parsed.fileName, parsed.kind ?? 'image')
      if (!filePath) {
        return null
      }
      try {
        const buf = await readFile(filePath)
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
      } catch (error) {
        console.warn('[pet-overlay] pet:read failed', error)
        return null
      }
    }
  )

  ipcMain.handle(
    'pet:delete',
    async (_event, id: string, fileName: string, kind?: 'image' | 'bundle'): Promise<void> => {
      // Why: validate IPC inputs before any path logic.
      let parsed: z.infer<typeof PetFileRequestSchema>
      try {
        parsed = PetFileRequestSchema.parse({ id, fileName, kind })
      } catch {
        throw new Error('Invalid pet:delete arguments')
      }
      if (!isSafeId(parsed.id)) {
        return
      }
      if ((parsed.kind ?? 'image') === 'bundle') {
        // Why: defense in depth — verify path stays under pets root before recursive removal.
        const root = normalize(getPetsDir())
        const target = normalize(join(root, parsed.id))
        if (!target.startsWith(root + sep)) {
          return
        }
        try {
          await rm(target, { recursive: true, force: true })
        } catch (error) {
          console.warn('[pet-overlay] pet:delete (bundle) failed', error)
        }
        return
      }
      const filePath = resolvePetFile(parsed.id, parsed.fileName, 'image')
      if (!filePath) {
        return
      }
      try {
        await rm(filePath, { force: true })
      } catch (error) {
        console.warn('[pet-overlay] pet:delete failed', error)
      }
    }
  )
}
