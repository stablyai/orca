import type { AgentMessageSender } from '../../../../../shared/agent-session/journal/agent-session-message-source'
import { readWorkerTerminalHostScope } from '../../../../../shared/orchestration/workers/worker-terminal-host-scope'
import type { OrchestrationDb } from '../../db/orchestration-db'
import type { DispatchContextRow } from '../../db/orchestration-records'
import { canonicalOrcaSessionId } from '../../addressing/session-lineage/canonical-orca-session-id'
import { resolveOrchestrationParty } from '../../addressing/orchestration-party'
import { runCoordinatorKey } from '../../addressing/orchestration-caller-identity'
import { isOrcaSessionId } from '../../../../../shared/agent-session/identity/orca-session-address'
import { getRemoteDispatch } from '../../db/remote-owned/remote-dispatch-records'

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
  workerDispatch?: Pick<DispatchContextRow, 'creator_turn_source'>
}

const UNKNOWN: Lineage = { relation: undefined }

// What Orca mails as a local worker's dispatch that is that worker's result: its failed start, its
// loss, mail it never got. Its questions and setup status are not (they stay where they were asked).
const LOCAL_DISPATCH_RESULTS: ReadonlySet<string> = new Set(['escalation', 'worker_done'])

/** Whether `sender` speaks as this Dispatch's own worker, as a local coordinator decides it: a
 *  federated worker as its Dispatch, Orca writing a local Dispatch's result as it, or the bound
 *  assignee of a Dispatch on this machine. Who started the Dispatch is the caller's question. */
export function sendsAsDispatchWorker(
  db: OrchestrationDb,
  dispatch: DispatchContextRow,
  sender: Party & { address?: string },
  messageType: string | undefined
): boolean {
  if (sender.address === `dispatch:${dispatch.id}`) {
    return (
      Boolean(db.getFederatedDispatch(dispatch.id)) ||
      (localDispatch(dispatch) && LOCAL_DISPATCH_RESULTS.has(messageType ?? ''))
    )
  }
  return (
    localDispatch(dispatch) &&
    sameParty(sender, {
      terminalHandle: dispatch.assignee_handle,
      orcaSessionId: dispatch.assignee_orca_session_id
    })
  )
}

/** A federated worker mails as its dispatch, and so does Orca for a local one: 'worker' only when
 *  that dispatch, in the Run, was created by the recipient, and for a local one only its results;
 *  anything else is unknown. */
function dispatchWorkerLineage(
  db: OrchestrationDb,
  dispatchId: string,
  args: Pick<RelationArgs, 'runId' | 'messageType'>,
  recipient: Party
): Lineage {
  const { runId } = args
  const dispatch = db.getDispatchContextById(dispatchId)
  const known =
    dispatch &&
    sendsAsDispatchWorker(
      db,
      dispatch,
      { address: `dispatch:${dispatchId}`, terminalHandle: null, orcaSessionId: null },
      args.messageType
    )
  const creator = known && dispatch.run_id === runId ? dispatch : null
  return creator &&
    sameParty(
      { terminalHandle: creator.creator_handle, orcaSessionId: creator.creator_orca_session_id },
      recipient
    )
    ? { relation: 'worker', workerDispatch: creator }
    : UNKNOWN
}

/** A paired server's worker for this Run (worker-start --on): 'worker' when this Orca's own receipt
 *  of the start names the recipient as its asker, as a local Dispatch's creator does. */
function remoteWorkerLineage(
  db: OrchestrationDb,
  dispatchId: string,
  runId: string,
  recipient: Party
): Lineage {
  const record = getRemoteDispatch(db, dispatchId)
  return record?.run_id === runId &&
    record.asker_proven === 1 &&
    sameParty(
      {
        terminalHandle: record.creator_handle,
        orcaSessionId:
          record.creator_orca_session_id && isOrcaSessionId(record.creator_orca_session_id)
            ? record.creator_orca_session_id
            : null
      },
      recipient
    )
    ? { relation: 'worker', workerDispatch: { creator_turn_source: record.creator_turn_source } }
    : UNKNOWN
}

type RelationArgs = {
  db: OrchestrationDb | null
  sender: AgentMessageSender['party']
  recipient: string
  runId: string
  reportedDispatchId?: string
  recipientDispatchId: string | null
  /** The mail's type: a local dispatch's own mail is lineage only for its results. */
  messageType?: string
  /** A start outcome Orca wrote for this Dispatch, proven by its runtime-minted id. */
  startOutcomeDispatchId?: string
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
    // A paired server's worker has no Dispatch here: only Orca's own report of its start counts.
    if (args.startOutcomeDispatchId && !db.getDispatchContextById(args.startOutcomeDispatchId)) {
      return remoteWorkerLineage(db, args.startOutcomeDispatchId, runId, recipient)
    }
    if (sender.address.startsWith('dispatch:')) {
      return dispatchWorkerLineage(db, sender.address.slice('dispatch:'.length), args, recipient)
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
          sendsAsDispatchWorker(
            db,
            row,
            { terminalHandle: party.terminalHandle, orcaSessionId: party.orcaSessionId },
            args.messageType
          )
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
