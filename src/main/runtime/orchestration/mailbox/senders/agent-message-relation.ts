import type { AgentMessageSender } from '../../../../../shared/agent-session/journal/agent-session-message-source'
import { readWorkerTerminalHostScope } from '../../../../../shared/orchestration/workers/worker-terminal-host-scope'
import type { OrchestrationDb } from '../../db/orchestration-db'
import type { DispatchContextRow } from '../../db/orchestration-records'
import { canonicalOrcaSessionId } from '../../addressing/session-lineage/canonical-orca-session-id'
import { resolveOrchestrationParty } from '../../addressing/orchestration-party'
import { runCoordinatorKey } from '../../addressing/orchestration-caller-identity'

type Party = Pick<AgentMessageSender['party'], 'terminalHandle' | 'orcaSessionId'>

function sameParty(a: Party, b: Party): boolean {
  if (a.orcaSessionId && b.orcaSessionId) {
    return canonicalOrcaSessionId(a.orcaSessionId) === canonicalOrcaSessionId(b.orcaSessionId)
  }
  return Boolean(a.terminalHandle && a.terminalHandle === b.terminalHandle)
}

function localDispatch(dispatch: DispatchContextRow): boolean {
  const scope = readWorkerTerminalHostScope(dispatch.host_scope)
  return scope.kind === 'absent' || (scope.kind === 'local' && scope.id === 'local')
}

/** How a sender relates to its recipient, and, for a worker, the Dispatch that proves it. */
export type Lineage = {
  relation: AgentMessageSender['relation']
  workerDispatch?: DispatchContextRow
}

const UNKNOWN: Lineage = { relation: undefined }

/** A federated worker mails as its dispatch: 'worker' only when this host started that dispatch in
 *  the Run for the recipient; anything else is unknown. */
function federatedWorkerLineage(
  db: OrchestrationDb,
  dispatchId: string,
  runId: string,
  recipient: Party
): Lineage {
  const dispatch = db.getFederatedDispatch(dispatchId)
    ? db.getDispatchContextById(dispatchId)
    : null
  const creator = dispatch?.run_id === runId ? dispatch : null
  return creator &&
    sameParty(
      { terminalHandle: creator.creator_handle, orcaSessionId: creator.creator_orca_session_id },
      recipient
    )
    ? { relation: 'worker', workerDispatch: creator }
    : UNKNOWN
}

type RelationArgs = {
  db: OrchestrationDb | null
  sender: AgentMessageSender['party']
  recipient: string
  runId: string
  reportedDispatchId?: string
  recipientDispatchId: string | null
}

/** Delivery-time evidence only; missing, ambiguous or foreign lineage is unknown. */
export function agentMessageRelation(args: RelationArgs): AgentMessageSender['relation'] {
  return agentMessageLineage(args).relation
}

/** A worker's mail reports to where the turn that started it came from: a turn its coordinator's
 *  connector conversation woke sends it back there; any other stays in Orca. */
export function reportsToConversation(lineage: Lineage): boolean {
  return (
    lineage.relation === 'worker' && lineage.workerDispatch?.creator_turn_source === 'connector'
  )
}

export function agentMessageLineage(args: RelationArgs): Lineage {
  try {
    const { db, sender, runId } = args
    if (!db || args.recipient.startsWith('dispatch:')) {
      return UNKNOWN
    }
    const run = db.getRun(runId)
    if (!run) {
      return UNKNOWN
    }
    const recipient =
      args.recipient === `run:${runId}`
        ? runCoordinatorKey(run)
        : resolveOrchestrationParty(args.recipient, db)
    if (sender.address.startsWith('dispatch:')) {
      return federatedWorkerLineage(db, sender.address.slice('dispatch:'.length), runId, recipient)
    }
    const coordinator = runCoordinatorKey(run)
    const dispatchFor = (party: Party, id?: string | null) => {
      const candidates = id
        ? [db.getDispatchContextById(id)]
        : db.getActiveDispatchMailboxOwners(
            party.terminalHandle ??
              (party.orcaSessionId ? `orca_session_id:${party.orcaSessionId}` : '')
          )
      const matches = candidates.filter((row): row is DispatchContextRow =>
        Boolean(
          row &&
          row.run_id === runId &&
          localDispatch(row) &&
          sameParty(party, {
            terminalHandle: row.assignee_handle,
            orcaSessionId: row.assignee_orca_session_id
          })
        )
      )
      return matches.length === 1 ? matches[0] : undefined
    }
    const parentOf = (dispatch: DispatchContextRow | undefined): Party | undefined => {
      if (!dispatch) {
        return undefined
      }
      if (dispatch.creator_handle || dispatch.creator_orca_session_id) {
        return {
          terminalHandle: dispatch.creator_handle,
          orcaSessionId: dispatch.creator_orca_session_id
        }
      }
      if (dispatch.creator_dispatch_id) {
        const creator = db.getDispatchContextById(dispatch.creator_dispatch_id)
        return creator && creator.run_id === runId && localDispatch(creator)
          ? {
              terminalHandle: creator.assignee_handle,
              orcaSessionId: creator.assignee_orca_session_id
            }
          : undefined
      }
      return undefined
    }
    const senderDispatch = dispatchFor(sender, args.reportedDispatchId)
    const recipientDispatch = dispatchFor(recipient, args.recipientDispatchId)
    const senderParent = parentOf(senderDispatch)
    const recipientParent = parentOf(recipientDispatch)
    if (!sameParty(sender, recipient)) {
      if (senderParent && sameParty(senderParent, recipient)) {
        return { relation: 'worker', ...(senderDispatch ? { workerDispatch: senderDispatch } : {}) }
      }
      if (recipientParent && sameParty(recipientParent, sender)) {
        return { relation: 'coordinator' }
      }
    }
    return (senderParent || sameParty(sender, coordinator)) &&
      (recipientParent || sameParty(recipient, coordinator))
      ? { relation: 'none' }
      : UNKNOWN
  } catch {
    // Lineage is informational; an unavailable database must never block delivery.
    return UNKNOWN
  }
}
