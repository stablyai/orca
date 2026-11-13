import { creatureNameTier } from '../../../../shared/worktree/retired-name-registry'

/** Persist canonical generator names only; repeat-suffixed collision fallbacks cannot be generated again. */
export function normalizeRetirableGeneratedName(name: string): string | null {
  const normalized = name.trim().toLowerCase()
  return normalized.length <= 256 && creatureNameTier(normalized) !== null ? normalized : null
}
