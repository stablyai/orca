import type { SparsePreset } from '../../shared/worktree/create-types'
import { normalizeSparseDirectories } from './sparse-checkout-directories'

/**
 * The preset a sparse create is recorded under: only one of this repo's presets whose directories
 * are exactly the ones checked out, so an edited selection is never shown as the preset it began as.
 */
export function attributedSparsePresetId(
  readPresets: () => readonly SparsePreset[],
  repoId: string,
  presetId: string | undefined,
  sparseDirectories: readonly string[]
): string | undefined {
  if (!presetId) {
    return undefined
  }
  try {
    const preset = readPresets().find((entry) => entry.id === presetId)
    if (preset?.repoId !== repoId) {
      return undefined
    }
    // Set-based so directory order doesn't matter, as the renderer's `sparseDirectoriesMatch` does.
    const presetSet = new Set(normalizeSparseDirectories(preset.directories))
    const checkedOutSet = new Set(sparseDirectories)
    const directoriesMatch =
      presetSet.size === checkedOutSet.size &&
      [...checkedOutSet].every((entry) => presetSet.has(entry))
    return directoriesMatch ? preset.id : undefined
  } catch {
    // Unreadable or corrupt preset data must not block the create or falsely label the new worktree.
    return undefined
  }
}
