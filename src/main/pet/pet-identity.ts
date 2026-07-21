import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getCanonicalUserDataPath } from '../persistence'

/**
 * Normalize a pet id into the identity that TRAVELS between surfaces.
 *
 * The desktop and the phone name the same creature differently. A pet imported
 * from Petdex is stored under `sidekicks/custom/<uuid>/`, so the renderer's
 * store holds a per-install UUID like `4aa6e196-…`. The phone bundles the same
 * creature by its catalogue slug (`mini-gandalf-the-grey`) because that is the
 * directory name under `resources/pets/mesh-defaults` that Metro compiled in.
 *
 * A UUID is meaningless on any other machine — it is minted at import time, so
 * two hosts that imported the same pet disagree. The slug is the only stable
 * cross-surface name, and it is written to `pet.json` beside the spritesheet at
 * import time precisely so it survives.
 *
 * Resolving here rather than in the renderer keeps one definition of "which
 * pet" behind the single writer, instead of every surface inventing its own
 * translation.
 */
export function resolveTravellingPetId(petId: string): string {
  // Bundled desktop pets (claude-the-mage etc.) are already slugs and have no
  // custom directory; leave them untouched.
  try {
    const manifest = join(getCanonicalUserDataPath(), 'sidekicks', 'custom', petId, 'pet.json')
    if (!existsSync(manifest)) {
      return petId
    }
    const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { id?: unknown }
    return typeof parsed.id === 'string' && parsed.id.trim() !== '' ? parsed.id : petId
  } catch {
    // An unreadable manifest must not stop the pet from having an identity —
    // falling back to the raw id keeps the desktop correct even if the phone
    // then declines the handoff.
    return petId
  }
}
