import type { SkillSourceKind } from '../../shared/skills'
import type { SkillScanRoot } from './skill-discovery-sources'

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
