import { stat } from 'node:fs/promises'
import { PetImportError } from '../../shared/pet-import-failure-copy'
import { isAbsolute, resolve, sep } from 'node:path'
import { classifyFile } from './pet-image-formats'
import { MAX_BYTES } from './pet-import-size-limits'
import { isSymlink } from './pet-symlink-safe-copy'
import type { PetManifestLike, ResolvedPetManifest } from './pet-bundle'

export async function resolveBundleSpritesheetSource<T extends PetManifestLike>(
  manifest: ResolvedPetManifest<T>,
  bundleDir: string
): Promise<{ sheetSrc: string; sheetClass: { mimeType: string; ext: string } }> {
  // Manifest paths are untrusted; require a relative path before the containment and symlink checks.
  const normalizedSpritePath = manifest.spritesheetPath.replace(/[\\/]+/g, sep)
  if (
    isAbsolute(manifest.spritesheetPath) ||
    isAbsolute(normalizedSpritePath) ||
    /^[a-zA-Z]:/.test(manifest.spritesheetPath)
  ) {
    throw new PetImportError('sheetPathNotRelative')
  }
  // Accept Windows-exported bundles on macOS/Linux.
  const sheetSrc = resolve(bundleDir, normalizedSpritePath)
  const bundleResolved = resolve(bundleDir)
  if (sheetSrc === bundleResolved) {
    throw new PetImportError('sheetPathIsRoot')
  }
  const bundleRoot = bundleResolved + sep
  // Match paths case-insensitively on Windows.
  const cmp = process.platform === 'win32' ? (s: string) => s.toLowerCase() : (s: string) => s
  if (!cmp(sheetSrc + sep).startsWith(cmp(bundleRoot))) {
    throw new PetImportError('sheetPathEscapes')
  }
  if (await isSymlink(sheetSrc)) {
    throw new PetImportError('sheetSymlink')
  }
  const sheetClass = classifyFile(sheetSrc)
  if (!sheetClass || sheetClass.ext === '.svg') {
    // Sprite layouts require raster dimensions.
    throw new PetImportError('sheetUnsupportedType')
  }
  let sheetStat: Awaited<ReturnType<typeof stat>>
  try {
    sheetStat = await stat(sheetSrc)
  } catch {
    throw new PetImportError('sheetNotFound')
  }
  if (!sheetStat.isFile()) {
    throw new PetImportError('sheetNotAFile')
  }
  if (sheetStat.size > MAX_BYTES) {
    throw new PetImportError('sheetTooLarge', { size: (sheetStat.size / (1024 * 1024)).toFixed(1) })
  }
  return { sheetSrc, sheetClass }
}
