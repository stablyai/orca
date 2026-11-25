/**
 * What Orca's own locked rebase proved before Git ran: the branch's upstream tip was already part
 * of the pre-rebase branch, so after the rebase the remote only holds old copies of our commits.
 * Kept in memory per worktree and bound to the paused run's incarnation; a restart forgets it,
 * which fails closed (Pull and Sync stay offered).
 */
export type OrcaRebaseProvenance = {
  branch: string
  integratedUpstreamOid: string
  incarnation: string
}

const provenanceByWorktree = new Map<string, OrcaRebaseProvenance>()

export function recordOrcaRebaseProvenance(
  worktreePath: string,
  provenance: OrcaRebaseProvenance
): void {
  provenanceByWorktree.set(worktreePath, provenance)
}

/** Hands back the proof only for the same paused run on the same branch, then forgets it. */
export function takeOrcaRebaseProvenance(
  worktreePath: string,
  branch: string | null,
  incarnation: string | null
): string | null {
  const provenance = provenanceByWorktree.get(worktreePath)
  provenanceByWorktree.delete(worktreePath)
  if (!provenance || provenance.branch !== branch || provenance.incarnation !== incarnation) {
    return null
  }
  return provenance.integratedUpstreamOid
}
