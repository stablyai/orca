import type { ExecutionHostId } from '../../shared/execution-host'
import { LOCAL_EXECUTION_HOST_ID, toSshExecutionHostId } from '../../shared/execution-host'
import type { PtyLivenessVerdict } from '../../shared/pty-liveness-verdict'
import { NO_OBSERVING_PROVIDER_REASON } from '../../shared/pty-liveness-verdict'
import type { AgentStatusPtyInventoryCandidate } from '../agent-hooks/server/server-pty-inventory-settlement'

/** What one completed inventory pass proved, and for whom. */
export type AgentStatusPtyInventoryAnswer = Readonly<{
  /** Scope of the pass: `undefined` aggregates every host, `null` is local only, a string is one SSH target. */
  connectionId: string | null | undefined
  queriedHostIds: ReadonlySet<ExecutionHostId>
  allLivePtyIds: ReadonlySet<string>
}>

/** The agent-status store's half of the settlement, as the runtime sees it. */
export type AgentStatusPtyInventorySettlementPort = Readonly<{
  listCandidates: () => readonly AgentStatusPtyInventoryCandidate[]
  /** Returns the number of panes actually retired, after the store re-checks its own fences. */
  settle: (settled: readonly AgentStatusPtyInventoryCandidate[]) => number
}>

export type AgentStatusPtyInventorySettlementDeps = AgentStatusPtyInventorySettlementPort &
  Readonly<{
    /** The workspace's own declared execution host; null when its provenance is unknown. */
    resolveRowExecutionHostId: (
      candidate: AgentStatusPtyInventoryCandidate
    ) => ExecutionHostId | null
    /** PTY bound to the pane in this runtime now. Re-read after the verdict to fence a rebind. */
    getBoundPtyIdForPaneKey: (paneKey: string) => string | undefined
    /** PTY the pane was bound to when that host's session was last persisted; covers a pane whose
     *  surviving session was never reattached, which is the whole cross-restart case. */
    getPersistedPtyIdForPaneKey: (paneKey: string, hostId: ExecutionHostId) => string | undefined
    /** The shipped liveness register. `exited` here is a host-delivered death certificate. */
    readLivenessVerdict: (ptyId: string) => PtyLivenessVerdict | null
    /** False only when the owning provider proved the PTY absent; null is doubt, never a denial. */
    probePtyLiveness: (ptyId: string) => Promise<boolean | null>
  }>

/** A per-SSH-target pass says nothing about local panes, and vice versa. */
export function inventoryCoversConnection(
  scope: string | null | undefined,
  rowConnectionId: string | null
): boolean {
  if (scope === undefined) {
    return true
  }
  if (scope === null) {
    return rowConnectionId === null
  }
  return rowConnectionId === scope
}

function hostIdForRow(candidate: AgentStatusPtyInventoryCandidate): ExecutionHostId {
  return candidate.connectionId
    ? toSshExecutionHostId(candidate.connectionId)
    : LOCAL_EXECUTION_HOST_ID
}

/**
 * Read one PTY's liveness in the one vocabulary Orca has for it.
 *
 * A recorded `exited` is the only thing here strong enough to stand alone: it can only have been
 * written by a host-delivered exit frame, which is also the only way a remote PTY can ever earn a
 * death certificate. Everything else re-asks the owning provider, because an inventory's own
 * silence is the union of "dead" and "minted before the provider restarted".
 */
async function readPtyVerdict(
  ptyId: string,
  deps: AgentStatusPtyInventorySettlementDeps
): Promise<PtyLivenessVerdict> {
  const recorded = deps.readLivenessVerdict(ptyId)
  if (recorded?.status === 'exited') {
    return recorded
  }
  let probed: boolean | null
  try {
    probed = await deps.probePtyLiveness(ptyId)
  } catch {
    probed = null
  }
  if (probed === false) {
    return { status: 'exited' }
  }
  if (probed === true) {
    return { status: 'live', ptyIds: [ptyId] }
  }
  return {
    status: 'unverifiable',
    reason: recorded?.status === 'unverifiable' ? recorded.reason : NO_OBSERVING_PROVIDER_REASON
  }
}

/**
 * Settle the agent-status rows a completed inventory pass proved have no process behind them.
 *
 * Only `exited` settles. `live` and `unverifiable` both do nothing at all — losing contact with a
 * host is not a death certificate, and a pass that never asked a host has no standing over its
 * panes (docs/reference/ssh-execution-boundary.md).
 */
export async function settleAgentStatusRowsAbsentFromInventory(
  answer: AgentStatusPtyInventoryAnswer,
  deps: AgentStatusPtyInventorySettlementDeps
): Promise<number> {
  const adjudicable: { candidate: AgentStatusPtyInventoryCandidate; ptyId: string }[] = []
  for (const candidate of deps.listCandidates()) {
    // Scope before evidence: a per-target pass would otherwise read every local row as absent.
    if (!inventoryCoversConnection(answer.connectionId, candidate.connectionId)) {
      continue
    }
    const hostId = hostIdForRow(candidate)
    // An inventory proves absence only for hosts that actually answered.
    if (!answer.queriedHostIds.has(hostId)) {
      continue
    }
    // The workspace's own declared owner has to agree. Unknown provenance, or a paired runtime
    // host this process does not execute, is never adjudicated by a local or SSH listing.
    if (deps.resolveRowExecutionHostId(candidate) !== hostId) {
      continue
    }
    const ptyId =
      deps.getBoundPtyIdForPaneKey(candidate.paneKey) ??
      deps.getPersistedPtyIdForPaneKey(candidate.paneKey, hostId)
    // With no PTY to name, there is no process to ask about — that is doubt, not absence.
    if (!ptyId || answer.allLivePtyIds.has(ptyId)) {
      continue
    }
    adjudicable.push({ candidate, ptyId })
  }
  if (adjudicable.length === 0) {
    return 0
  }
  const verdictByPtyId = new Map<string, Promise<PtyLivenessVerdict>>()
  const boundAtVerdictByPaneKey = new Map<string, string | undefined>()
  for (const { candidate, ptyId } of adjudicable) {
    boundAtVerdictByPaneKey.set(candidate.paneKey, deps.getBoundPtyIdForPaneKey(candidate.paneKey))
    if (!verdictByPtyId.has(ptyId)) {
      verdictByPtyId.set(ptyId, readPtyVerdict(ptyId, deps))
    }
  }
  const settled: AgentStatusPtyInventoryCandidate[] = []
  for (const { candidate, ptyId } of adjudicable) {
    const verdict = await verdictByPtyId.get(ptyId)!
    if (verdict.status !== 'exited') {
      continue
    }
    // A cold restore can rebind the pane while its verdict is in flight; the answer we have is
    // then about a PTY this pane no longer is.
    if (
      deps.getBoundPtyIdForPaneKey(candidate.paneKey) !==
      boundAtVerdictByPaneKey.get(candidate.paneKey)
    ) {
      continue
    }
    settled.push(candidate)
  }
  return settled.length === 0 ? 0 : deps.settle(settled)
}
