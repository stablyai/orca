import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import {
  appendRetiredTerminalSurfaceProofs,
  dropRetirementProofsForLiveSurfaces
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
