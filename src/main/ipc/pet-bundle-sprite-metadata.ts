import { nativeImage } from 'electron'
import { PetImportError } from '../../shared/pet-import-failure-copy'
import { readFile } from 'node:fs/promises'
import type { CustomPet } from '../../shared/pet-types'
import { MAX_BYTES } from './pet-import-size-limits'
import { readWebpDimensionsFromBuffer } from './pet-bundle'
import type { PetManifestLike, ResolvedPetManifest } from './pet-bundle'

async function readSheetDimensions(
  buffer: Buffer
): Promise<{ width: number; height: number } | null> {
  // Chromium renders some WebP variants nativeImage cannot decode; prefer header dimensions.
  const webpDims = readWebpDimensionsFromBuffer(buffer)
  if (webpDims) {
    return webpDims
  }

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

/** Without a frame layout, the renderer uses spriteFps. */
export async function buildBundleSprite<T extends PetManifestLike>(
  manifest: ResolvedPetManifest<T>,
  sheetSrc: string
): Promise<NonNullable<CustomPet['sprite']> | undefined> {
  let sprite: NonNullable<CustomPet['sprite']> | undefined
  if (manifest.frame) {
    // Decode only for layout validation; nativeImage may reject otherwise renderable WebP.
    const sheetBuf = await readFile(sheetSrc)
    // Recheck the read size because the file may have grown after stat.
    if (sheetBuf.byteLength > MAX_BYTES) {
      throw new PetImportError('sheetSizeLimitExceeded')
    }
    const dims = await readSheetDimensions(sheetBuf)
    if (!dims) {
      throw new PetImportError('sheetUndecodable')
    }
    const { width: fw, height: fh } = manifest.frame
    if (dims.width % fw !== 0 || dims.height % fh !== 0) {
      throw new PetImportError('sheetFrameMismatch', {
        sheetWidth: dims.width,
        sheetHeight: dims.height,
        frameWidth: fw,
        frameHeight: fh
      })
    }
    const columns = dims.width / fw
    const rows = dims.height / fh
    if (manifest.animations) {
      for (const [name, anim] of Object.entries(manifest.animations)) {
        if (anim.row >= rows) {
          throw new PetImportError('animationRowOutOfRange', { name, row: anim.row, rows })
        }
        if (anim.frames > columns) {
          throw new PetImportError('animationTooManyFrames', {
            name,
            frames: anim.frames,
            columns
          })
        }
        if (anim.frameDurationsMs && anim.frameDurationsMs.length !== anim.frames) {
          throw new PetImportError('animationDurationMismatch', {
            name,
            durations: anim.frameDurationsMs.length,
            frames: anim.frames
          })
        }
      }
      if (manifest.defaultAnimation && !manifest.animations[manifest.defaultAnimation]) {
        throw new PetImportError('defaultAnimationMissing', { name: manifest.defaultAnimation })
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
