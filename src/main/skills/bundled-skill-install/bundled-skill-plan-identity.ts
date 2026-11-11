import { createHash } from 'node:crypto'
import type { BundledSkillObserved } from '../../../shared/bundled-skill-plan'

/** Fixed plan construction order makes JSON serialization canonical. */
export function bundledSkillDigestOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function sameBundledSkillObserved(
  left: BundledSkillObserved,
  right: BundledSkillObserved
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}
