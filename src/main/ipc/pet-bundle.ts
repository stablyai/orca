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
