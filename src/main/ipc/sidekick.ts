/* eslint-disable max-lines */
import { app, BrowserWindow, dialog, ipcMain, nativeImage } from 'electron'
import { copyFile, mkdir, readFile, rename, rm, stat, lstat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, dirname, extname, isAbsolute, join, normalize, resolve, sep } from 'node:path'
import { z } from 'zod'
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
const MAX_MANIFEST_BYTES = 64 * 1024 // pet.json is tiny by spec; cap to defend against a malicious bundle stuffing megabytes into the manifest.

function isSafeId(id: string): boolean {
  // UUIDs only; blocks path traversal and unexpected characters. Storage ids
  // are always generated in main (never sourced from the bundle's manifest.id),
  // so this regex is the canonical gate for any fs path that includes the id.
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
}

function resolveSidekickFile(id: string, fileName: string, kind: 'image' | 'bundle'): string | null {
  if (!isSafeId(id)) {
    return null
  }
  const safeName = basename(fileName)
  const root = normalize(getSidekicksDir())
  let filePath: string
  if (kind === 'bundle') {
    // Bundle layout: custom/<id>/<fileName>. fileName is just the spritesheet
    // basename (e.g. "spritesheet.webp"); pet.json is read by main only and
    // never served to the renderer.
    filePath = normalize(join(root, id, safeName))
    const bundleDir = normalize(join(root, id)) + sep
    if (!filePath.startsWith(bundleDir)) {
      return null
    }
    return filePath
  }
  // Legacy image layout: custom/<id>.<ext>. Filename must start with the id
  // so the prefix check catches any edge case that slipped the regex.
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
      // Why: belt-and-suspenders against malicious manifests — downstream
      // resolve+prefix check still runs as defense in depth.
      .refine(
        (p) => !p.includes('\0') && !p.startsWith('/') && !p.startsWith('\\') && !p.includes('..'),
        'invalid spritesheetPath'
      ),
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
          frames: z.number().int().positive().max(512)
        })
      )
      .optional()
  })
  // Why: tolerate unknown top-level fields. Pet-bundle generators may emit
  // descriptive metadata (e.g. "kind": "person") we don't consume yet, and
  // strict mode would reject those imports with a confusing "unrecognized
  // key" error instead of just ignoring the extras.
  .loose()

type PetManifest = z.infer<typeof PetManifestSchema>

// Why: renderer-supplied IPC inputs are untrusted — validate shape before any
// path resolution. resolveSidekickFile still gates the actual filesystem path.
const SidekickFileRequestSchema = z.object({
  id: z.string(),
  fileName: z.string(),
  kind: z.enum(['image', 'bundle']).optional()
})

async function readSheetDimensions(
  buffer: Buffer
): Promise<{ width: number; height: number } | null> {
  // Why: nativeImage decodes PNG/JPEG/GIF/WebP/BMP. SVG isn't supported here
  // (vector → no integer pixel grid), so pet bundles must use a raster sheet.
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

async function isSymlink(path: string): Promise<boolean> {
  try {
    const s = await lstat(path)
    return s.isSymbolicLink()
  } catch {
    return false
  }
}

export function registerSidekickHandlers(): void {
  ipcMain.handle('sidekick:import', async (event): Promise<CustomSidekick | null> => {
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
      mimeType: classified.mimeType,
      kind: 'image'
    }
  })

  ipcMain.handle('sidekick:importPetBundle', async (event): Promise<CustomSidekick | null> => {
    const senderWindow =
      BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow()
    // Why: the bundle is a folder. macOS users may also pick `pet.json` itself
    // when Finder is set to show package contents — the post-pick logic walks
    // up to the parent directory in that case.
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

    let manifest: PetManifest
    try {
      const raw = await readFile(manifestPath, 'utf8')
      // Why: defend against TOCTOU between stat and read — the file could have
      // grown after the stat check.
      if (Buffer.byteLength(raw, 'utf8') > MAX_MANIFEST_BYTES) {
        throw new Error('pet.json exceeded the manifest size limit.')
      }
      manifest = PetManifestSchema.parse(JSON.parse(raw))
    } catch (error) {
      throw new Error(`Invalid pet.json: ${error instanceof Error ? error.message : 'parse error'}`)
    }

    // Why: spritesheetPath is bundle-relative. Reject absolute paths and any
    // resolved path that escapes the bundle directory. Also reject symlinks so
    // a malicious bundle can't reach outside via a sibling link.
    if (isAbsolute(manifest.spritesheetPath)) {
      throw new Error('spritesheetPath must be relative to the bundle.')
    }
    const sheetSrc = resolve(bundleDir, manifest.spritesheetPath)
    const bundleResolved = resolve(bundleDir)
    if (sheetSrc === bundleResolved) {
      throw new Error('spritesheetPath must point to a file, not the bundle root.')
    }
    const bundleRoot = bundleResolved + sep
    // Why: NTFS/macOS HFS+ default volumes are case-insensitive — a path like
    // `BUNDLE\sheet.png` is still inside `bundle\`. Compare lowercased on
    // Windows so the prefix check isn't bypassed by case differences.
    const cmp =
      process.platform === 'win32' ? (s: string) => s.toLowerCase() : (s: string) => s
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

    let sprite: NonNullable<CustomSidekick['sprite']> | undefined
    if (manifest.frame) {
      // Why: only decode the sheet when we need to validate frame layout.
      // nativeImage may fail on some WebP variants in headless contexts, and
      // bundles without `frame` render as a static image where dimensions
      // don't matter.
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

    // Why: storage id is always a fresh UUID — the manifest's `id` is purely
    // a display hint. This guards against (a) collisions with bundled
    // sidekick ids, (b) failing isSafeId, and (c) re-import clobbering an
    // earlier copy of the same bundle.
    const id = randomUUID()
    const root = getSidekicksDir()
    await mkdir(root, { recursive: true })
    const destDir = join(root, id)
    const sheetExt = sheetClass.ext
    const sheetFileName = `spritesheet${sheetExt}`
    // Why: stage the bundle into a sibling .tmp directory and atomically rename
    // into place so destDir only appears once both files are written. Avoids
    // half-imported bundles if a copy fails midway.
    const tmpDir = `${destDir}.tmp`
    try {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
      await mkdir(tmpDir, { recursive: true })
      await copyFile(sheetSrc, join(tmpDir, sheetFileName))
      await copyFile(manifestPath, join(tmpDir, 'pet.json'))
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
      // Why: carries manifest.fps for detected-frame bundles where `sprite`
      // is undefined — renderer falls back to this when sprite is absent.
      ...(manifest.fps !== undefined ? { spriteFps: manifest.fps } : {})
    }
  })

  ipcMain.handle(
    'sidekick:read',
    async (
      _event,
      id: string,
      fileName: string,
      kind?: 'image' | 'bundle'
    ): Promise<ArrayBuffer | null> => {
      // Why: validate IPC inputs before any path logic — renderer is not
      // trusted to send strings of the right shape.
      let parsed: z.infer<typeof SidekickFileRequestSchema>
      try {
        parsed = SidekickFileRequestSchema.parse({ id, fileName, kind })
      } catch {
        throw new Error('Invalid sidekick:read arguments')
      }
      // Why: missing kind defaults to 'image' for backwards compatibility with
      // pre-bundle persisted state.
      const filePath = resolveSidekickFile(parsed.id, parsed.fileName, parsed.kind ?? 'image')
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

  ipcMain.handle(
    'sidekick:delete',
    async (
      _event,
      id: string,
      fileName: string,
      kind?: 'image' | 'bundle'
    ): Promise<void> => {
      // Why: validate IPC inputs before any path logic.
      let parsed: z.infer<typeof SidekickFileRequestSchema>
      try {
        parsed = SidekickFileRequestSchema.parse({ id, fileName, kind })
      } catch {
        throw new Error('Invalid sidekick:delete arguments')
      }
      if (!isSafeId(parsed.id)) {
        return
      }
      if ((parsed.kind ?? 'image') === 'bundle') {
        // Why: bundle imports own a whole directory. isSafeId already gates id;
        // we still build the path under the sidekicks root and verify the
        // prefix before recursive removal as defense in depth.
        const root = normalize(getSidekicksDir())
        const target = normalize(join(root, parsed.id))
        if (!target.startsWith(root + sep)) {
          return
        }
        try {
          await rm(target, { recursive: true, force: true })
        } catch (error) {
          console.warn('[sidekick-overlay] sidekick:delete (bundle) failed', error)
        }
        return
      }
      const filePath = resolveSidekickFile(parsed.id, parsed.fileName, 'image')
      if (!filePath) {
        return
      }
      try {
        await rm(filePath, { force: true })
      } catch (error) {
        console.warn('[sidekick-overlay] sidekick:delete failed', error)
      }
    }
  )
}
