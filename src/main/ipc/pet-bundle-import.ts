import { BrowserWindow, dialog } from 'electron'
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import type { CustomPet } from '../../shared/pet-types'
import { applyCodexPetDefaults, type ResolvedPetManifest } from './pet-bundle'
import { PetManifestSchema, type PetManifest } from './pet-bundle-manifest-schema'
import { buildBundleSprite } from './pet-bundle-sprite-metadata'
import { resolveBundleSpritesheetSource } from './pet-bundle-spritesheet-source'
import { MAX_MANIFEST_BYTES } from './pet-import-size-limits'
import { getPetsDir } from './pet-storage-paths'
import { copyFileNoFollow, isSymlink } from './pet-symlink-safe-copy'

export async function importPetBundle(
  event: Electron.IpcMainInvokeEvent
): Promise<CustomPet | null> {
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

  const { sheetSrc, sheetClass } = await resolveBundleSpritesheetSource(manifest, bundleDir)

  const sprite = await buildBundleSprite(manifest, sheetSrc)

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
}
