import {
  SUPPORTED_GLOBAL_SKILL_TOPOLOGIES,
  type SkillFreshnessInstallation
} from '../../shared/skill-freshness'

/**
 * Names that did not land, judged from the post-run inventory.
 *
 * Why not "whatever is still in `eligibleUpdateNames`": a name leaves that list
 * for reasons that are not success. A half-written bundle hashes to
 * `unrecognized`, a failed write can leave the directory unreadable, and a
 * removed skill has no convergent placement at all — each would read as
 * "updated" and show a green check over a broken skill. So demand a positive
 * signal instead: every placement the command writes to has to come back as a
 * revision we recognise.
 *
 * Known limit: the topology filter runs before the status check, so a placement
 * that degrades OUT of the convergent set is dropped from the judgment rather
 * than failing it. A run that rewrites the canonical copy but leaves a
 * provider-alias a broken symlink still reports success. Catching that needs the
 * pre-run inventory to compare convergent-then against convergent-now; every
 * wholly-degraded and removed-entirely case is already reported as a failure.
 */
export function skillUpdateFailedNames(
  names: readonly string[],
  installations: readonly SkillFreshnessInstallation[]
): string[] {
  return names.filter((name) => {
    const convergent = installations.filter(
      (entry) => entry.name === name && SUPPORTED_GLOBAL_SKILL_TOPOLOGIES.has(entry.topology)
    )
    if (convergent.length === 0) {
      return true
    }
    // `newer-known` counts as landed: the CLI pulls from the source repo, which
    // can be ahead of the revision this build ships in its manifest.
    return convergent.some((entry) => entry.status !== 'current' && entry.status !== 'newer-known')
  })
}
