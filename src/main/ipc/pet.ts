/* eslint-disable max-lines */
import { app, BrowserWindow, dialog, ipcMain, nativeImage } from 'electron'
import { copyFile, mkdir, open, readFile, rename, rm, stat, lstat } from 'node:fs/promises'
import { constants as fsConstants, createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { randomUUID } from 'node:crypto'
import { basename, dirname, extname, isAbsolute, join, normalize, resolve, sep } from 'node:path'
import { z } from 'zod'
import type { CustomPet } from '../../shared/types'
import {
  applyCodexPetDefaults,
  readWebpDimensionsFromBuffer,
  type PetManifestLike,
  type ResolvedPetManifest
} from './pet-bundle'

// Why: pets are image-only — render natively via <img> (no 3D engine); main owns this format allowlist.
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

// Why: keep the legacy `sidekicks` folder so existing user-uploaded pets keep rendering after the product rename.
function getPetsDir(): string {
  return join(app.getPath('userData'), 'sidekicks', 'custom')
}

const MAX_BYTES = 64 * 1024 * 1024 // 64 MB — generous but bounded so a user can't point at a multi-GB file and OOM the renderer when it builds a Blob URL.
const MAX_MANIFEST_BYTES = 64 * 1024 // pet.json is tiny by spec; cap to defend against a malicious bundle stuffing megabytes into the manifest.

function isSafeId(id: string): boolean {
  // UUIDs only — canonical path-traversal gate; storage ids are always main-generated, never from manifest.id.
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
}

function resolvePetFile(id: string, fileName: string, kind: 'image' | 'bundle'): string | null {
  if (!isSafeId(id)) {
    return null
  }
  const safeName = basename(fileName)
  const root = normalize(getPetsDir())
  let filePath: string
  if (kind === 'bundle') {
    // Bundle layout custom/<id>/<fileName>; fileName is the spritesheet basename — pet.json is main-only, never served.
    filePath = normalize(join(root, id, safeName))
    const bundleDir = normalize(join(root, id)) + sep
    if (!filePath.startsWith(bundleDir)) {
      return null
    }
    return filePath
  }
  // Legacy image layout custom/<id>.<ext>; filename must start with the id so the prefix check backstops the regex.
  if (!safeName.startsWith(`${id}.`)) {
    return null
  }
  filePath = normalize(join(root, safeName))
  if (!filePath.startsWith(root + sep)) {
    return null
  }
  return filePath
}

const PetManifestSchema = z
  .object({
    id: z.string().min(1).max(128).optional(),
    displayName: z.string().min(1).max(120).optional(),
    description: z.string().max(2000).optional(),
    spritesheetPath: z
      .string()
      .min(1)
      .max(255)
      // Why: belt-and-suspenders vs malicious manifests — downstream resolve+prefix check still runs as defense in depth.
      .refine(
        (p) => !p.includes('\0') && !p.startsWith('/') && !p.startsWith('\\') && !p.includes('..'),
        'invalid spritesheetPath'
      )
      .optional(),
    frame: z
      .object({
        width: z.number().int().positive().max(1024),
        height: z.number().int().positive().max(1024)
      })
      .optional(),
    fps: z.number().positive().max(60).optional(),
    defaultAnimation: z.string().min(1).max(64).optional(),
    animations: z
      .record(
        z.string().min(1).max(64),
        z.object({
          row: z.number().int().min(0).max(256),
          frames: z.number().int().positive().max(512),
          // Why: cap each hold at 60s so a bad manifest can't freeze the overlay.
          frameDurationsMs: z.array(z.number().positive().max(60_000)).max(512).optional()
        })
      )
      .optional()
  })
  // Why: .loose() ignores unknown manifest fields — generators emit metadata we don't consume; strict would reject imports.
  .loose()

type PetManifest = z.infer<typeof PetManifestSchema> & PetManifestLike

// Why: renderer IPC inputs are untrusted — validate shape here; resolvePetFile still gates the actual filesystem path.
const PetFileRequestSchema = z.object({
  id: z.string(),
  fileName: z.string(),
  kind: z.enum(['image', 'bundle']).optional()
})

async function readSheetDimensions(
  buffer: Buffer
): Promise<{ width: number; height: number } | null> {
  // Why: nativeImage can fail on some valid WebP that Chromium renders — read WebP dims from the header before native decode.
  const webpDims = readWebpDimensionsFromBuffer(buffer)
  if (webpDims) {
    return webpDims
  }

  // Why: nativeImage can't decode SVG (vector → no pixel grid) — pet bundles must use a raster sheet.
  const image = nativeImage.createFromBuffer(buffer)
  if (image.isEmpty()) {
    return null
  }
  const size = image.getSize()
  if (size.width <= 0 || size.height <= 0) {
    return null
  }
  return { width: size.width, height: size.height }
}

// Why: TOCTOU symlink-swap defense — O_NOFOLLOW makes open() fail on a symlink; Windows lacks it, so fall back to copyFile.
async function copyFileNoFollow(src: string, dest: string): Promise<void> {
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0
  if (noFollow === 0) {
    await copyFile(src, dest)
    return
  }
  const fh = await open(src, fsConstants.O_RDONLY | noFollow)
  try {
    await pipeline(fh.createReadStream({ autoClose: false }), createWriteStream(dest))
  } finally {
    await fh.close()
  }
}

async function isSymlink(path: string): Promise<boolean> {
  try {
    const s = await lstat(path)
    return s.isSymbolicLink()
  } catch {
    return false
  }
}

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

  ipcMain.handle('pet:importPetBundle', async (event): Promise<CustomPet | null> => {
    const senderWindow =
      BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow()
    // Why: the bundle is a folder, but Finder may let users pick `pet.json` inside it — post-pick logic walks up to the parent.
    const options: Electron.OpenDialogOptions = {
      title: 'Pick a .codex-pet bundle',
      properties: ['openFile', 'openDirectory', 'treatPackageAsDirectory']
    }
    const result = senderWindow
      ? await dialog.showOpenDialog(senderWindow, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) {
      return null
    }
    const picked = result.filePaths[0]
    let bundleDir: string
    try {
      const pickedStat = await stat(picked)
      bundleDir = pickedStat.isDirectory() ? picked : dirname(picked)
    } catch {
      throw new Error('Could not read the selected path.')
    }

    const manifestPath = join(bundleDir, 'pet.json')
    let manifestStat: Awaited<ReturnType<typeof stat>>
    try {
      manifestStat = await stat(manifestPath)
    } catch {
      throw new Error('Bundle is missing pet.json.')
    }
    if (!manifestStat.isFile() || manifestStat.size > MAX_MANIFEST_BYTES) {
      throw new Error('pet.json is invalid.')
    }
    if (await isSymlink(manifestPath)) {
      throw new Error('pet.json must not be a symlink.')
    }

    let manifest: ResolvedPetManifest<PetManifest>
    try {
      const raw = await readFile(manifestPath, 'utf8')
      // Why: defend against TOCTOU — the file may have grown between the stat check and this read.
      if (Buffer.byteLength(raw, 'utf8') > MAX_MANIFEST_BYTES) {
        throw new Error('pet.json exceeded the manifest size limit.')
      }
      manifest = applyCodexPetDefaults(PetManifestSchema.parse(JSON.parse(raw)))
    } catch (error) {
      throw new Error(`Invalid pet.json: ${error instanceof Error ? error.message : 'parse error'}`)
    }

    // Why: spritesheetPath is bundle-relative and attacker-controlled — reject absolute/escaping paths (and symlinks) so a bundle can't reach outside.
    const normalizedSpritePath = manifest.spritesheetPath.replace(/[\\/]+/g, sep)
    if (
      isAbsolute(manifest.spritesheetPath) ||
      isAbsolute(normalizedSpritePath) ||
      /^[a-zA-Z]:/.test(manifest.spritesheetPath)
    ) {
      throw new Error('spritesheetPath must be relative to the bundle.')
    }
    // Why: bundles exported on Windows may be imported on macOS/Linux; normalize separators before resolving.
    const sheetSrc = resolve(bundleDir, normalizedSpritePath)
    const bundleResolved = resolve(bundleDir)
    if (sheetSrc === bundleResolved) {
      throw new Error('spritesheetPath must point to a file, not the bundle root.')
    }
    const bundleRoot = bundleResolved + sep
    // Why: Windows volumes are case-insensitive; lowercase the prefix compare so case differences can't bypass the escape check.
    const cmp = process.platform === 'win32' ? (s: string) => s.toLowerCase() : (s: string) => s
    if (!cmp(sheetSrc + sep).startsWith(cmp(bundleRoot))) {
      throw new Error('spritesheetPath escapes the bundle.')
    }
    if (await isSymlink(sheetSrc)) {
      throw new Error('spritesheet must not be a symlink.')
    }
    const sheetClass = classifyFile(sheetSrc)
    if (!sheetClass || sheetClass.ext === '.svg') {
      // SVG can't be used as a sprite sheet (no pixel grid).
      throw new Error('Spritesheet must be a PNG, APNG, JPG, GIF, or WebP.')
    }
    let sheetStat: Awaited<ReturnType<typeof stat>>
    try {
      sheetStat = await stat(sheetSrc)
    } catch {
      throw new Error('Spritesheet file not found.')
    }
    if (!sheetStat.isFile()) {
      throw new Error('Spritesheet path is not a file.')
    }
    if (sheetStat.size > MAX_BYTES) {
      throw new Error(
        `Spritesheet is too large (${(sheetStat.size / (1024 * 1024)).toFixed(1)} MB).`
      )
    }

    let sprite: NonNullable<CustomPet['sprite']> | undefined
    if (manifest.frame) {
      // Why: only decode when a frame layout needs validating — nativeImage can fail on some WebP variants in headless contexts.
      const sheetBuf = await readFile(sheetSrc)
      // Why: defend against TOCTOU — file may have grown between stat and read.
      if (sheetBuf.byteLength > MAX_BYTES) {
        throw new Error('Spritesheet exceeded the size limit.')
      }
      const dims = await readSheetDimensions(sheetBuf)
      if (!dims) {
        throw new Error('Could not decode the spritesheet image.')
      }
      const { width: fw, height: fh } = manifest.frame
      if (dims.width % fw !== 0 || dims.height % fh !== 0) {
        throw new Error(
          `Spritesheet ${dims.width}×${dims.height} is not a clean multiple of frame ${fw}×${fh}.`
        )
      }
      const columns = dims.width / fw
      const rows = dims.height / fh
      if (manifest.animations) {
        for (const [name, anim] of Object.entries(manifest.animations)) {
          if (anim.row >= rows) {
            throw new Error(`Animation "${name}" references row ${anim.row} but sheet has ${rows}.`)
          }
          if (anim.frames > columns) {
            throw new Error(
              `Animation "${name}" has ${anim.frames} frames but sheet only has ${columns} columns.`
            )
          }
          if (anim.frameDurationsMs && anim.frameDurationsMs.length !== anim.frames) {
            throw new Error(
              `Animation "${name}" declares ${anim.frameDurationsMs.length} frame durations but ${anim.frames} frames.`
            )
          }
        }
        if (manifest.defaultAnimation && !manifest.animations[manifest.defaultAnimation]) {
          throw new Error(`defaultAnimation "${manifest.defaultAnimation}" not in animations.`)
        }
      }
      sprite = {
        frameWidth: fw,
        frameHeight: fh,
        columns,
        rows,
        sheetWidth: dims.width,
        sheetHeight: dims.height,
        fps: manifest.fps ?? 8,
        defaultAnimation: manifest.defaultAnimation,
        animations: manifest.animations
      }
    }

    // Why: always a fresh UUID (not the manifest's display-hint id) to avoid collisions, unsafe ids, and re-import clobbering.
    const id = randomUUID()
    const root = getPetsDir()
    await mkdir(root, { recursive: true })
    const destDir = join(root, id)
    const sheetExt = sheetClass.ext
    const sheetFileName = `spritesheet${sheetExt}`
    // Why: stage into a sibling .tmp then atomically rename, so a mid-copy failure can't leave a half-imported bundle.
    const tmpDir = `${destDir}.tmp`
    try {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
      await mkdir(tmpDir, { recursive: true })
      await copyFileNoFollow(sheetSrc, join(tmpDir, sheetFileName))
      await copyFileNoFollow(manifestPath, join(tmpDir, 'pet.json'))
      await rename(tmpDir, destDir)
    } catch {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
      throw new Error('Could not save the pet bundle.')
    }

    const rawLabel = (manifest.displayName ?? manifest.id ?? basename(bundleDir)).trim()
    const label = rawLabel.length > 0 ? rawLabel.slice(0, 40) : 'Pet bundle'
    return {
      id,
      label,
      fileName: sheetFileName,
      mimeType: sheetClass.mimeType,
      kind: 'bundle',
      sprite,
      // Why: renderer falls back to spriteFps when sprite is undefined (detected-frame bundles).
      ...(manifest.fps !== undefined ? { spriteFps: manifest.fps } : {})
    }
  })

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
