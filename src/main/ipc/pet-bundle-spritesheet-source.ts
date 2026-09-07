import { stat } from 'node:fs/promises'
import { isAbsolute, resolve, sep } from 'node:path'
import { classifyFile } from './pet-image-formats'
import { MAX_BYTES } from './pet-import-size-limits'
import { isSymlink } from './pet-symlink-safe-copy'
import type { PetManifestLike, ResolvedPetManifest } from './pet-bundle'

/** Validated spritesheet source inside a bundle: an absolute path plus its allowlisted format. */
export async function resolveBundleSpritesheetSource<T extends PetManifestLike>(
  manifest: ResolvedPetManifest<T>,
  bundleDir: string
): Promise<{ sheetSrc: string; sheetClass: { mimeType: string; ext: string } }> {
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
    throw new Error(`Spritesheet is too large (${(sheetStat.size / (1024 * 1024)).toFixed(1)} MB).`)
  }
  return { sheetSrc, sheetClass }
}
