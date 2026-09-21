import { normalizeRetirableGeneratedName } from '../../worktree-name-retirement'
import {
  clampExhaustedTiers,
  compactRetiredNames,
  isEmptyRetiredNameRegistry,
  type RetiredNameRegistry
} from '../../../shared/worktree/retired-name-registry'

function normalizeRetiredNameRegistry(row: unknown): RetiredNameRegistry {
  const isPlainArray = Array.isArray(row)
  const rawRow = row as { exhaustedTiers?: unknown; names?: unknown } | null | undefined
  const rawNames = isPlainArray ? row : Array.isArray(rawRow?.names) ? rawRow.names : []
  const names = new Set<string>()
  for (const entry of rawNames) {
    if (typeof entry !== 'string') {
      continue
    }
    const normalized = normalizeRetirableGeneratedName(entry)
    if (normalized) {
      names.add(normalized)
    }
  }
  return compactRetiredNames({
    exhaustedTiers: isPlainArray ? 0 : clampExhaustedTiers(rawRow?.exhaustedTiers),
    names: [...names]
  })
}

export function normalizeRetiredNameRegistryMap(
  value: unknown
): Record<string, RetiredNameRegistry> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  const byRepo: Record<string, RetiredNameRegistry> = {}
  for (const [repoId, row] of Object.entries(value as Record<string, unknown>)) {
    if (!repoId) {
      continue
    }
    const registry = normalizeRetiredNameRegistry(row)
    if (!isEmptyRetiredNameRegistry(registry)) {
      byRepo[repoId] = registry
    }
  }
  return byRepo
}
