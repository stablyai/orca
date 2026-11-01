import type { AgentMessageSender } from '../../../shared/agent-session/agent-session-message-source'
import { readWorkerTerminalHostScope } from '../../../shared/worker-terminal-host-scope'
import type { OrchestrationDb, DispatchContextRow } from './db'
import { canonicalOrcaSessionId } from './canonical-orca-session-id'
import { resolveOrchestrationParty } from './orchestration-party'
import { runCoordinatorKey } from './orchestration-caller-identity'

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

/** Delivery-time evidence only; missing, ambiguous or foreign lineage is unknown. */
export function agentMessageRelation(args: {
  db: OrchestrationDb | null
  sender: AgentMessageSender['party']
  recipient: string
  runId: string
  reportedDispatchId?: string
  recipientDispatchId: string | null
}): AgentMessageSender['relation'] {
  try {
    const { db, sender, runId } = args
    if (!db || sender.address.startsWith('dispatch:') || args.recipient.startsWith('dispatch:')) {
      return undefined
    }
    const run = db.getRun(runId)
    if (!run) {
      return undefined
    }
    const recipient =
      args.recipient === `run:${runId}`
        ? runCoordinatorKey(run)
        : resolveOrchestrationParty(args.recipient, db)
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
        return 'worker'
      }
      if (recipientParent && sameParty(recipientParent, sender)) {
        return 'coordinator'
      }
    }
    return (senderParent || sameParty(sender, coordinator)) &&
      (recipientParent || sameParty(recipient, coordinator))
      ? 'none'
      : undefined
  } catch {
    // Lineage is informational; an unavailable database must never block delivery.
    return undefined
  }
}
