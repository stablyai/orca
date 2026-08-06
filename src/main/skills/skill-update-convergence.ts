import {
  SUPPORTED_GLOBAL_SKILL_TOPOLOGIES,
  type SkillFreshnessInstallation,
  type SkillKnownSnapshot
} from '../../shared/skill-freshness'

/**
 * Names `skills update` can still move, judged against what it believes it installed.
 *
 * The updater decides what to do by comparing its lock's `skillFolderHash` against
 * the source tree; it never reads disk. So once the lock records a revision the
 * filesystem does not actually have, the command reports "up to date", exits 0 and
 * writes nothing — no retry converges it. Offering an update there promises work the
 * command cannot do, which is exactly what `eligibleSkillUpdateNames` exists to avoid.
 *
 * The honest signal is the lock's hash versus the `gitTreeSha` of the revision the
 * DISK hashes to. Deliberately not versus the bundled manifest: the updater pulls from
 * the source repo, which legitimately runs ahead of what this build ships, and gating
 * on the bundle would withhold real updates. When lock and disk agree, an update is
 * still genuinely available and stays on offer.
 *
 * Unknown either way (no lock entry, or disk content matching no known revision) is
 * left eligible — silence is not evidence the command is stuck.
 */
export function convergableSkillNames(
  installations: readonly SkillFreshnessInstallation[],
  globalSkillLocks: ReadonlyMap<string, string>,
  knownSnapshots: Readonly<Record<string, SkillKnownSnapshot[]>>
): ReadonlySet<string> {
  const convergable = new Set(globalSkillLocks.keys())
  for (const [name, lockHash] of globalSkillLocks) {
    // Why: judged only over the placements the command writes, like eligibility
    // itself. A plugin-cache or repo copy is never the command's to converge, so
    // it must neither gate the name nor rescue it — an unidentifiable cache copy
    // (or one parked at the lock's own revision) would otherwise defeat the gate
    // and re-arm the unwinnable update.
    const observable = installations.filter(
      (entry) =>
        entry.name === name &&
        SUPPORTED_GLOBAL_SKILL_TOPOLOGIES.has(entry.topology) &&
        entry.observedPackageDigest
    )
    if (observable.length === 0) {
      continue
    }
    const revisions = knownSnapshots[name] ?? []
    // Why: the revision each placement resolved to during observation, not a fresh
    // lookup by whole-folder digest. Identity tolerates files the manifest never
    // listed, so a folder holding an agent CLI's sidecar digests to nothing any
    // revision knows — re-deriving here would call every such placement
    // unidentifiable and quietly retire the gate for the users who most need it.
    const diskTreeShas = observable
      .map(
        (entry) =>
          revisions.find((revision) => revision.releaseRevision === entry.installedReleaseRevision)
            ?.gitTreeSha
      )
      .filter((sha): sha is string => Boolean(sha))
    // Why: only claim the lock is stale when BOTH sides are positively identified —
    // the lock names a revision we know, and every placement resolves to a different
    // known revision. A lock hash we cannot place (a source we do not bundle, a
    // revision older than the registry) is not evidence of anything, and gating on it
    // would withhold updates that would have worked.
    const lockNamesAKnownRevision = revisions.some((entry) => entry.gitTreeSha === lockHash)
    // `diskTreeShas` drops placements that resolved to no known revision, so requiring
    // every observable one to resolve is what keeps `every` honest: without it, one
    // stale copy beside one unidentifiable copy would gate the name off the resolved
    // half alone, contradicting the unknown-stays-eligible rule above.
    const everyPlacementResolved = diskTreeShas.length === observable.length
    if (
      lockNamesAKnownRevision &&
      everyPlacementResolved &&
      diskTreeShas.length > 0 &&
      diskTreeShas.every((sha) => sha !== lockHash)
    ) {
      convergable.delete(name)
    }
  }
  return convergable
}
