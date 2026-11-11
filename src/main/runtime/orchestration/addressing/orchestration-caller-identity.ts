import type { RunRow } from '../db/orchestration-records'
import type { PeerRunRow } from '../db/peer-runs/peer-run-store'
import { isEquivalentPaneKey } from '../db/pane-key-match'
import { currentRunCoordinatorOrcaSessionId } from '../db/runs/run-coordinator-orca-session'
import {
  formatOrcaSessionAddress,
  type OrcaSessionId
} from '../../../../shared/orca-session-address'
import type { OrchestrationPartyIdentity as OrchestrationCallerIdentity } from '../../../../shared/orchestration/mailbox/orchestration-party-identity'

/** The part of a caller a Run binding stores and matches. */
export type OrchestrationCoordinatorKey = Pick<
  OrchestrationCallerIdentity,
  'terminalHandle' | 'paneKey' | 'orcaSessionId'
>

/** A caller the dispatch entry resolved from the Orca session id in its injected environment. */
export type OrchestrationSessionCaller = OrchestrationCallerIdentity &
  Readonly<{
    kind?: undefined
    orcaSessionId: OrcaSessionId
    /** The session record the request came from. */
    sessionId: OrcaSessionId
    /** Where the session runs, from its record; `worker-start --worktree current` places here. */
    workspaceId: string
  }>

/** A paired Orca acting as the coordinator of its Run here, as its authenticated frame names it.
 *  Its handle and binding key are its address, which no terminal or session here can have. */
export type OrchestrationPeerCaller = OrchestrationCallerIdentity &
  Readonly<{
    kind: 'peer'
    terminalHandle: string
    paneKey: string
    orcaSessionId: null
    peerRun: PeerRunRow
  }>

/** The caller the dispatch entry resolved, which wins over any declared handle: a session from
 *  its environment, or a paired Orca from its pairing. */
export type OrchestrationEntryCaller = OrchestrationSessionCaller | OrchestrationPeerCaller

/** The address, and Run binding key, of the paired Orca coordinating a conversation's Run here. */
export function peerCoordinatorAddress(conversationId: string): string {
  return `${PEER_ADDRESS_PREFIX}${conversationId}`
}

const PEER_ADDRESS_PREFIX = 'peer:'

export function isPeerCoordinatorAddress(value: string | null | undefined): boolean {
  return !!value?.startsWith(PEER_ADDRESS_PREFIX)
}

export function peerCoordinatorCaller(peerRun: PeerRunRow): OrchestrationPeerCaller {
  const address = peerCoordinatorAddress(peerRun.conversation_id)
  return Object.freeze({
    kind: 'peer',
    address,
    terminalHandle: address,
    paneKey: address,
    orcaSessionId: null,
    peerRun
  })
}

export function isPeerCaller(
  caller: OrchestrationCallerIdentity | null | undefined
): caller is OrchestrationPeerCaller {
  return !!caller && 'kind' in caller && caller.kind === 'peer'
}

/** A caller with neither a pane nor an Orca session id can never be bound to a Run. */
export function hasRunBindingKey(caller: OrchestrationCoordinatorKey): boolean {
  return caller.paneKey !== null || caller.orcaSessionId !== null
}

/** The one address a party reads mail at and is sent mail at; null for a key naming nobody. */
export function mailboxAddressOf(
  party: Pick<OrchestrationCoordinatorKey, 'terminalHandle' | 'orcaSessionId'>
): string | null {
  // Workers read mail at their handles, so prefer that address when both identities exist.
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

export function runBoundToCoordinator(
  run: Pick<
    RunRow,
    | 'coordinator_pane_key'
    | 'coordinator_orca_session_id'
    | 'coordinator_orca_session_id_generation'
    | 'consumer_generation'
  >,
  caller: OrchestrationCoordinatorKey
): boolean {
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
