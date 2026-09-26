import type { RunRow } from './types'
import { isEquivalentPaneKey } from './db/pane-key-match'
import { currentRunCoordinatorOrcaSessionId } from './db/runs/run-coordinator-orca-session'
import { formatOrcaSessionAddress, type OrcaSessionId } from '../../../shared/orca-session-address'

/**
 * Who an orchestration caller is, as Run binding and mail routing match it.
 *
 * A PTY agent is its terminal: a handle and a pane key, no Orca session id. An agent that is a
 * structured session is its Orca session id, addressed as `session:<id>`; a structured worker also
 * has the handle and pane key it was minted, and an ordinary chat has neither. Methods pass this
 * through whole and never branch on which fields are set; the lookups below own that.
 */
export type OrchestrationCallerIdentity = Readonly<{
  /** Mailbox address the caller sends from and reads: its terminal handle, else its session address. */
  address: string
  terminalHandle: string | null
  paneKey: string | null
  /** The bare Orca session id the caller is addressed by; mail spells it `session:<id>`. */
  orcaSessionId: OrcaSessionId | null
}>

/** The part of a caller a Run binding stores and matches. */
export type OrchestrationCoordinatorKey = Pick<
  OrchestrationCallerIdentity,
  'terminalHandle' | 'paneKey' | 'orcaSessionId'
>

/** A caller the dispatch entry resolved from the Orca session id in its injected environment. */
export type OrchestrationSessionCaller = OrchestrationCallerIdentity &
  Readonly<{
    orcaSessionId: OrcaSessionId
    /** The session record the request came from. */
    sessionId: OrcaSessionId
    /** Where the session runs, from its record; `worker-start --worktree current` places here. */
    workspaceId: string
  }>

/** A caller with neither a pane nor an Orca session id can never be bound to a Run. */
export function hasRunBindingKey(caller: OrchestrationCoordinatorKey): boolean {
  return caller.paneKey !== null || caller.orcaSessionId !== null
}

/** The one address a party reads mail at and is sent mail at; null for a key naming nobody. */
export function mailboxAddressOf(
  party: Pick<OrchestrationCoordinatorKey, 'terminalHandle' | 'orcaSessionId'>
): string | null {
  // Handle first because a worker's mail and Dispatch rows are keyed by it today; flips when sessions become canonical.
  if (party.terminalHandle !== null) {
    return party.terminalHandle
  }
  return party.orcaSessionId === null ? null : formatOrcaSessionAddress(party.orcaSessionId)
}

/** Who a Run's binding names now; an Orca session id an older binding left behind is not part of it. */
export function runCoordinatorKey(run: RunRow): OrchestrationCoordinatorKey {
  return {
    terminalHandle: run.coordinator_handle,
    paneKey: run.coordinator_pane_key,
    orcaSessionId: currentRunCoordinatorOrcaSessionId(run)
  }
}

export function runBoundToCoordinator(run: RunRow, caller: OrchestrationCoordinatorKey): boolean {
  if (
    caller.paneKey !== null &&
    run.coordinator_pane_key !== null &&
    isEquivalentPaneKey(run.coordinator_pane_key, caller.paneKey)
  ) {
    return true
  }
  return (
    caller.orcaSessionId !== null &&
    currentRunCoordinatorOrcaSessionId(run) === caller.orcaSessionId
  )
}
