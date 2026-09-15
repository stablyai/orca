import type { SkillSourceKind } from '../../shared/skills'
import type { SkillScanRoot } from './skill-discovery-sources'

export function skillScanSourceKinds(
  sourceKinds: readonly SkillSourceKind[] | undefined
): SkillSourceKind[] | undefined {
  if (!sourceKinds?.length) {
    return undefined
  }

  const kinds = new Set(sourceKinds)

  if (kinds.has('home') || kinds.has('bundled')) {
    kinds.add('home')
    kinds.add('bundled')
  }

  return [...kinds].sort()
}

export function rootMayContainSourceKind(
  root: SkillScanRoot,
  sourceKinds: readonly SkillSourceKind[] | undefined
): boolean {
  if (!sourceKinds?.length) {
    return true
  }

  if (root.sourceKind === 'home') {
    return sourceKinds.includes('home') || sourceKinds.includes('bundled')
  }

  return sourceKinds.includes(root.sourceKind)
}
