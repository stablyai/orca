import type { SkillBundleInstallResult } from '../../shared/skill-bundle-install-contract'

const MAX_ERROR_CATEGORIES = 32
const SAFE_ERROR_CATEGORY = /^[a-z0-9][a-z0-9._-]{0,63}$/i

export type SkillBundleObservationSummary = {
  attributes: Record<string, number>
  errorCategories: Map<string, number>
}

function increment(attributes: Record<string, number>, key: string): void {
  attributes[key] = (attributes[key] ?? 0) + 1
}

function recordErrorCategory(categories: Map<string, number>, value: string): void {
  const category = SAFE_ERROR_CATEGORY.test(value) ? value : 'other'
  const key =
    categories.has(category) || (category !== 'other' && categories.size < MAX_ERROR_CATEGORIES - 1)
      ? category
      : 'other'
  categories.set(key, (categories.get(key) ?? 0) + 1)
}

export function summarizeSkillBundleObservation(
  result: SkillBundleInstallResult
): SkillBundleObservationSummary {
  const attributes: Record<string, number> = {
    skillCount: result.skills.length,
    placementCount: 0,
    conflictCount: 0
  }
  const errorCategories = new Map<string, number>()
  for (const skill of result.skills) {
    increment(attributes, `${skill.status}SkillCount`)
    if (skill.conflict) {
      increment(attributes, 'conflictCount')
      increment(attributes, `${skill.conflict.kind}ConflictCount`)
    }
    if (skill.errorCategory) {
      recordErrorCategory(errorCategories, skill.errorCategory)
    }
    for (const placement of skill.placements) {
      increment(attributes, 'placementCount')
      increment(attributes, `${placement.topology}PlacementCount`)
      increment(attributes, `${placement.status}PlacementCount`)
      if (placement.errorCategory) {
        recordErrorCategory(errorCategories, placement.errorCategory)
      }
    }
  }
  return { attributes, errorCategories }
}
