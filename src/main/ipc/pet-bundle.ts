import type { SpriteAnimation } from '../../shared/types'
import {
  CODEX_PET_ANIMATIONS,
  CODEX_PET_DEFAULT_ANIMATION,
  CODEX_PET_DEFAULT_FPS,
  CODEX_PET_FRAME,
  CODEX_PET_SPRITESHEET_PATH,
  codexAnimationsAtUniformFps
} from '../../shared/codex-pet-sprite-defaults'

// Re-exported so main-side consumers keep their import path. The tables live
// in shared/ so the renderer can reuse the same fingerprint for upgrades.
export {
  CODEX_PET_ANIMATIONS,
  CODEX_PET_DEFAULT_ANIMATION,
  CODEX_PET_DEFAULT_FPS,
  CODEX_PET_FRAME,
  CODEX_PET_SPRITESHEET_PATH
}

export type PetManifestLike = {
  id?: string
  displayName?: string
  description?: string
  spritesheetPath?: string
  frame?: {
    width: number
    height: number
  }
  fps?: number
  defaultAnimation?: string
  animations?: Record<string, SpriteAnimation>
}

export type ResolvedPetManifest<T extends PetManifestLike = PetManifestLike> = T &
  PetManifestLike & {
    spritesheetPath: string
  }

function isCodexPetSpritePath(spritesheetPath: string | undefined): boolean {
  return spritesheetPath === undefined || /(^|[/\\])spritesheet\.webp$/i.test(spritesheetPath)
}

export function applyCodexPetDefaults<T extends PetManifestLike>(
  manifest: T
): ResolvedPetManifest<T> {
  const shouldApplyCodexLayout =
    isCodexPetSpritePath(manifest.spritesheetPath) &&
    manifest.frame === undefined &&
    manifest.animations === undefined

  if (!shouldApplyCodexLayout) {
    return {
      ...manifest,
      spritesheetPath: manifest.spritesheetPath ?? CODEX_PET_SPRITESHEET_PATH
    } as ResolvedPetManifest<T>
  }

  return {
    ...manifest,
    spritesheetPath: manifest.spritesheetPath ?? CODEX_PET_SPRITESHEET_PATH,
    frame: manifest.frame ?? CODEX_PET_FRAME,
    fps: manifest.fps ?? CODEX_PET_DEFAULT_FPS,
    defaultAnimation: manifest.defaultAnimation ?? CODEX_PET_DEFAULT_ANIMATION,
    // Why: with no fps, bake Codex's intended uneven pacing; with an explicit
    // fps, bake that as uniform durations so it is honored instead of being
    // overridden by the timed table (and stays out of the legacy retiming path).
    animations:
      manifest.animations ??
      (manifest.fps === undefined
        ? CODEX_PET_ANIMATIONS
        : codexAnimationsAtUniformFps(manifest.fps))
  }
}

function readUInt24LE(buffer: Buffer, offset: number): number {
  return buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16)
}

export function readWebpDimensionsFromBuffer(
  buffer: Buffer
): { width: number; height: number } | null {
  if (
    buffer.byteLength < 20 ||
    buffer.toString('ascii', 0, 4) !== 'RIFF' ||
    buffer.toString('ascii', 8, 12) !== 'WEBP'
  ) {
    return null
  }

  let offset = 12
  while (offset + 8 <= buffer.byteLength) {
    const chunkType = buffer.toString('ascii', offset, offset + 4)
    const chunkSize = buffer.readUInt32LE(offset + 4)
    const dataOffset = offset + 8
    const dataEnd = dataOffset + chunkSize
    if (dataEnd > buffer.byteLength) {
      return null
    }

    if (chunkType === 'VP8X' && chunkSize >= 10) {
      return {
        width: readUInt24LE(buffer, dataOffset + 4) + 1,
        height: readUInt24LE(buffer, dataOffset + 7) + 1
      }
    }

    if (chunkType === 'VP8L' && chunkSize >= 5 && buffer[dataOffset] === 0x2f) {
      const b0 = buffer[dataOffset + 1]
      const b1 = buffer[dataOffset + 2]
      const b2 = buffer[dataOffset + 3]
      const b3 = buffer[dataOffset + 4]
      return {
        width: 1 + (((b1 & 0x3f) << 8) | b0),
        height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6))
      }
    }

    if (
      chunkType === 'VP8 ' &&
      chunkSize >= 10 &&
      buffer[dataOffset + 3] === 0x9d &&
      buffer[dataOffset + 4] === 0x01 &&
      buffer[dataOffset + 5] === 0x2a
    ) {
      const width = buffer.readUInt16LE(dataOffset + 6) & 0x3fff
      const height = buffer.readUInt16LE(dataOffset + 8) & 0x3fff
      return width > 0 && height > 0 ? { width, height } : null
    }

    offset = dataEnd + (chunkSize % 2)
  }

  return null
}
