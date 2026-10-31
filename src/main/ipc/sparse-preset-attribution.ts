import type { SparsePreset } from '../../shared/worktree/create-types'
import { normalizeSparseDirectories } from './sparse-checkout-directories'

/** Attribute a preset only when its directories still match; edited selections must not retain the old label. */
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
    // Ignore directory order, matching renderer sparseDirectoriesMatch.
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
