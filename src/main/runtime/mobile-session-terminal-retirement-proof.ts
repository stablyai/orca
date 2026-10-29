import type {
  RuntimeMobileSessionRetiredTerminalSurface,
  RuntimeMobileSessionTabsSnapshot
} from '../../shared/runtime-types'
import {
  appendRetiredTerminalSurfaceProofs,
  dropRetirementProofsForLiveSurfaces,
  retirementProofKey
} from '../../shared/terminal-retirement-proof-ledger'

/** Carry durable host close proofs through renderer snapshots. Inherit worktreeInstanceId on identity-less host writes
 * so renderer(A) -> host -> renderer(B) cannot launder A's proofs into B. */
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

/** Attach proofs even after surface removal; bump snapshotVersion so freshness-gated clients accept retractions.
 * Return null for identical proofs to prevent no-op fan-out. */
export function attachRetirementProofsToSnapshot(
  snapshot: RuntimeMobileSessionTabsSnapshot,
  proofs: readonly RuntimeMobileSessionRetiredTerminalSurface[]
): RuntimeMobileSessionTabsSnapshot | null {
  if (proofs.length === 0) {
    return null
  }
  const merged = appendRetiredTerminalSurfaceProofs(snapshot.retiredTerminalSurfaces, proofs)
  const existing = snapshot.retiredTerminalSurfaces
  // Re-supplied proofs move to the tail; compare by key to avoid no-op version bumps.
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
