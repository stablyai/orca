import type {
  RuntimeMobileSessionRetiredTerminalSurface,
  RuntimeMobileSessionTabsSnapshot
} from '../../shared/runtime-types'
import {
  appendRetiredTerminalSurfaceProofs,
  dropRetirementProofsForLiveSurfaces,
  retirementProofKey
} from '../../shared/terminal-retirement-proof-ledger'

export {
  appendRetiredTerminalSurfaceProofs,
  dropRetirementProofsForLiveSurfaces
} from '../../shared/terminal-retirement-proof-ledger'

/**
 * Renderer snapshots omit the host's durable close acknowledgements; carry them forward.
 *
 * Why the identity inheritance: host-authored writes never set `worktreeInstanceId`. Without it
 * the stored entry forgets which occupant minted the proofs, and renderer(A) -> host write ->
 * renderer(B) would launder A's proofs into B.
 */
export function preserveTerminalRetirementProofs(
  snapshot: RuntimeMobileSessionTabsSnapshot,
  existing: RuntimeMobileSessionTabsSnapshot | undefined
): RuntimeMobileSessionTabsSnapshot {
  if (!existing || existing.worktree !== snapshot.worktree) {
    return snapshot
  }
  if (
    existing.worktreeInstanceId !== undefined &&
    snapshot.worktreeInstanceId !== undefined &&
    existing.worktreeInstanceId !== snapshot.worktreeInstanceId
  ) {
    return snapshot
  }
  const identified =
    snapshot.worktreeInstanceId === undefined && existing.worktreeInstanceId !== undefined
      ? { ...snapshot, worktreeInstanceId: existing.worktreeInstanceId }
      : snapshot
  if (!existing.retiredTerminalSurfaces?.length) {
    return identified
  }
  return {
    ...identified,
    retiredTerminalSurfaces: dropRetirementProofsForLiveSurfaces(
      appendRetiredTerminalSurfaceProofs(
        existing.retiredTerminalSurfaces,
        snapshot.retiredTerminalSurfaces ?? []
      ),
      snapshot.tabs
    )
  }
}

/**
 * Attaches durable retirement proofs to a stored snapshot, bumping its version so clients that
 * gate on a strictly newer `snapshotVersion` accept the frame. Returns null when the snapshot
 * already carries exactly these proofs, so a no-op cannot fan out.
 *
 * Separate from `retireTerminalSurfacesFromSnapshot`: that one only produces a proof as a
 * byproduct of removing the surface, and by the time a close's durable half runs the surface may
 * already be gone from the snapshot. The proof still has to ship — it is the only host evidence
 * that rides the frame carrying the retraction.
 */
export function attachRetirementProofsToSnapshot(
  snapshot: RuntimeMobileSessionTabsSnapshot,
  proofs: readonly RuntimeMobileSessionRetiredTerminalSurface[]
): RuntimeMobileSessionTabsSnapshot | null {
  if (proofs.length === 0) {
    return null
  }
  const merged = appendRetiredTerminalSurfaceProofs(snapshot.retiredTerminalSurfaces, proofs)
  const existing = snapshot.retiredTerminalSurfaces
  // Why by key, not by index: the append moves a re-supplied proof to the tail, so comparing
  // position would call a re-delivered exit a change and fan out a version bump carrying nothing.
  const priorByKey = new Map(
    (existing ?? []).map((proof) => [retirementProofKey(proof), proof] as const)
  )
  const unchanged =
    existing !== undefined &&
    merged.length === existing.length &&
    merged.every((proof) => {
      const prior = priorByKey.get(retirementProofKey(proof))
      return (
        prior !== undefined &&
        proof.ptyId === prior.ptyId &&
        proof.incarnationId === prior.incarnationId
      )
    })
  if (unchanged) {
    return null
  }
  return {
    ...snapshot,
    snapshotVersion: snapshot.snapshotVersion + 1,
    retiredTerminalSurfaces: merged
  }
}
