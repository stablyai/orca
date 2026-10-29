import {
  SESSION_TABS_RETIREMENT_PROOF_DELTA_RUNTIME_CAPABILITY,
  type RuntimeCapability
} from '../../../../shared/protocol-version'
import type { RuntimeMobileSessionRetiredTerminalSurface } from '../../../../shared/runtime-types'
import { retirementProofKey as proofKey } from '../../../../shared/terminal-retirement-proof-ledger'

type ProofCarrier = {
  worktree: string
  removed?: true
  retiredTerminalSurfaces?: RuntimeMobileSessionRetiredTerminalSurface[]
}

export type SessionTabsRetirementProofDelta = <TFrame extends ProofCarrier>(frame: TFrame) => TFrame

/** Send each proof once per capable stream instead of up to 64 on every title tick; legacy clients retain full lists. */
export function createSessionTabsRetirementProofDelta(
  clientCapabilities: readonly RuntimeCapability[] | undefined
): SessionTabsRetirementProofDelta {
  if (!clientCapabilities?.includes(SESSION_TABS_RETIREMENT_PROOF_DELTA_RUNTIME_CAPABILITY)) {
    return (frame) => frame
  }
  const sentByWorktree = new Map<string, Set<string>>()
  return <TFrame extends ProofCarrier>(frame: TFrame): TFrame => {
    if (frame.removed === true || frame.retiredTerminalSurfaces === undefined) {
      sentByWorktree.delete(frame.worktree)
      return frame
    }
    const sent = sentByWorktree.get(frame.worktree)
    const fresh = sent
      ? frame.retiredTerminalSurfaces.filter((proof) => !sent.has(proofKey(proof)))
      : frame.retiredTerminalSurfaces
    // Track current membership so a removed proof is sent again if it returns.
    sentByWorktree.set(frame.worktree, new Set(frame.retiredTerminalSurfaces.map(proofKey)))
    // Send [] for nothing new; omission means no held proofs and clears client state.
    return fresh.length === frame.retiredTerminalSurfaces.length
      ? frame
      : { ...frame, retiredTerminalSurfaces: fresh }
  }
}
