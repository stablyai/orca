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

/**
 * Per-stream projection that sends each retirement proof once. The host pins up to 64 proofs per
 * worktree for its process lifetime, so without this every title tick re-ships the whole list.
 * A capable client retains what it was sent; a legacy client keeps receiving the full list.
 */
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
    // Why: track exactly the current list, so a proof that leaves and returns is sent again.
    sentByWorktree.set(frame.worktree, new Set(frame.retiredTerminalSurfaces.map(proofKey)))
    // Why: an empty list is a real signal ("nothing new, keep yours"). Omitting the field would be
    // indistinguishable from a host that holds no proofs, which is what tells the client to forget.
    return fresh.length === frame.retiredTerminalSurfaces.length
      ? frame
      : { ...frame, retiredTerminalSurfaces: fresh }
  }
}
