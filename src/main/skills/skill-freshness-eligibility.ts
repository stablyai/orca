import {
  SUPPORTED_GLOBAL_SKILL_TOPOLOGIES,
  type SkillFreshnessInstallation
} from '../../shared/skill-freshness'

/**
 * Names the global update command can actually converge.
 *
 * Eligibility is decided purely over the placements that command touches — the
 * canonical copy and its symlink aliases. Copies it provably leaves alone (standalone
 * duplicates, project skills, plugin caches, links out of tree) neither authorize an
 * update nor withhold one: the badge would otherwise promise work the command cannot
 * do, or refuse work it could, over a copy that is never at stake either way. A
 * blocked *convergent* copy still withholds it, because that is the placement the
 * command would write to and overwriting it is the real data-loss case.
 */
export function eligibleSkillUpdateNames(
  installations: readonly SkillFreshnessInstallation[]
): string[] {
  const byName = new Map<string, SkillFreshnessInstallation[]>()
  for (const installation of installations) {
    const entries = byName.get(installation.name) ?? []
    entries.push(installation)
    byName.set(installation.name, entries)
  }

  const eligible: string[] = []
  for (const [, entries] of byName) {
    const convergent = entries.filter((entry) =>
      SUPPORTED_GLOBAL_SKILL_TOPOLOGIES.has(entry.topology)
    )
    // Why: without a convergent placement the command has no anchor, so it would
    // no-op or error against a canonical install that isn't there.
    if (convergent.length === 0) {
      continue
    }
    const hasOutdated = convergent.some((entry) => entry.status === 'outdated')
    const everyConvergentCopyIsSafeToWrite = convergent.every(
      (entry) =>
        (entry.status === 'current' || entry.status === 'outdated') &&
        Boolean(entry.resolvedPath && entry.physicalIdentity)
    )
    if (hasOutdated && everyConvergentCopyIsSafeToWrite) {
      eligible.push(entries[0].name)
    }
  }
  return eligible.sort((left, right) => left.localeCompare(right, 'en'))
}
