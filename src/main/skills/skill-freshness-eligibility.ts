import {
  SUPPORTED_GLOBAL_SKILL_TOPOLOGIES,
  type SkillFreshnessInstallation
} from '../../shared/skill-freshness'

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
  for (const [name, entries] of byName) {
    const hasOutdated = entries.some((entry) => entry.status === 'outdated')
    const everyPlacementIsOfficialAndUpdatable = entries.every(
      (entry) =>
        (entry.status === 'current' || entry.status === 'outdated') &&
        // Why: the rail reliably converges the canonical copy and its symlink aliases.
        // A standalone duplicate no longer blocks the whole name — the canonical copy
        // still updates and the duplicate row is flagged as maybe-not-reached — while
        // data-loss topologies (unrecognized/read-only/etc.) still poison via these checks.
        (SUPPORTED_GLOBAL_SKILL_TOPOLOGIES.has(entry.topology) ||
          entry.topology === 'independent-copy') &&
        Boolean(entry.resolvedPath && entry.physicalIdentity)
    )
    // Why: only offer the global command when a reliably-convergent placement anchors it,
    // so a skill that exists solely as a standalone copy never draws a command that could
    // no-op or error against a canonical install that isn't there.
    const hasReliableTarget = entries.some((entry) =>
      SUPPORTED_GLOBAL_SKILL_TOPOLOGIES.has(entry.topology)
    )
    if (hasOutdated && everyPlacementIsOfficialAndUpdatable && hasReliableTarget) {
      eligible.push(name)
    }
  }
  return eligible.sort((left, right) => left.localeCompare(right, 'en'))
}
