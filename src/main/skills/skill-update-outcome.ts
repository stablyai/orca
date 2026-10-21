import {
  SUPPORTED_GLOBAL_SKILL_TOPOLOGIES,
  type SkillFreshnessInstallation
} from '../../shared/skill-freshness'

/**
 * Names that did not land, judged from the post-run inventory.
 *
 * Why not "whatever is still in `eligibleUpdateNames`": a name leaves that list for
 * reasons that are not success. A failed write can leave the directory unreadable, and
 * a removed skill has no convergent placement at all; each would read as "updated" over
 * a broken skill. The install is pinned to this build, so every placement it writes has
 * to come back current.
 *
 * A broken link fails the name too: eligibility skips names that had one before the run,
 * so one after it is the run's own damage.
 */
export function skillUpdateFailedNames(
  names: readonly string[],
  installations: readonly SkillFreshnessInstallation[]
): string[] {
  return names.filter((name) => {
    const placements = installations.filter((entry) => entry.name === name)
    const convergent = placements.filter((entry) =>
      SUPPORTED_GLOBAL_SKILL_TOPOLOGIES.has(entry.topology)
    )
    return (
      convergent.length === 0 ||
      convergent.some((entry) => entry.status !== 'current') ||
      placements.some((entry) => entry.topology === 'broken-link')
    )
  })
}
