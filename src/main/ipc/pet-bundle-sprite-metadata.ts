import { nativeImage } from 'electron'
import { readFile } from 'node:fs/promises'
import type { CustomPet } from '../../shared/pet-types'
import { MAX_BYTES } from './pet-import-size-limits'
import { readWebpDimensionsFromBuffer } from './pet-bundle'
import type { PetManifestLike, ResolvedPetManifest } from './pet-bundle'

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

/** Undefined when the manifest declares no frame layout — the renderer then falls back to spriteFps. */
export async function buildBundleSprite<T extends PetManifestLike>(
  manifest: ResolvedPetManifest<T>,
  sheetSrc: string
): Promise<NonNullable<CustomPet['sprite']> | undefined> {
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
  return sprite
}
