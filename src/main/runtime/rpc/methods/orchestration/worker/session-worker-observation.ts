import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrcaSessionId } from '../../../../../../shared/orca-session-address'
import {
  chatAssigneeSessionId,
  observeChatAssignee,
  type ChatAssigneeObservation
} from '../../../../orchestration/chat-assignee'
import type { OrchestrationDb } from '../../../../orchestration/db'
import {
  holdStructuredWorker,
  observeStructuredSession
} from '../../../../structured-worker-authority'
import { resolveStructuredWorkerForDispatch } from '../../orchestration-structured-worker-lifecycle'

export type SessionWorkerObservation = {
  terminal: null
  exact: boolean
  status: 'identity_changed' | 'live' | 'exited' | 'unverifiable'
  reason?: string
  addressable?: boolean
  terminalHandle: null
}

/**
 * A worker that is an agent session, a structured worker or a chat, observed off the session
 * records instead of a terminal; null for a PTY worker.
 */
export async function inspectSessionWorker(
  runtime: Pick<OrcaRuntimeService, 'ensureStructuredAgentSessionHost'>,
  db: OrchestrationDb,
  dispatchId: string,
  terminalHandle: string
): Promise<SessionWorkerObservation | null> {
  const chat = chatAssigneeSessionId(terminalHandle)
  if (chat) {
    // The address is the chat's whole identity, so it is always exact. After a restart nothing
    // has installed the host yet, and its records are what this reads.
    await runtime.ensureStructuredAgentSessionHost().catch(() => undefined)
    const observed = observeChatAssignee(chat, db)
    return {
      terminal: null,
      exact: true,
      status: observed.status,
      ...(observed.status === 'unverifiable' ? { reason: observed.reason } : {}),
      terminalHandle: null
    }
  }
  const structured = resolveStructuredWorkerForDispatch(db, dispatchId)
  if (!structured) {
    return null
  }
  // Exactness is the recorded pane and process incarnation, which the runtime getters answer from the
  // structured registry; there is no terminal to show.
  //
  // `agentWait` is deliberately ABSENT rather than null. Null is the contract's "Orca looked and
  // found no wait", and nothing here looks: a structured worker parks on a journal question item,
  // which no terminal prompt scan can see. Reporting null would tell a coordinator the worker is
  // not waiting, which is the one thing the field's own documentation forbids inferring.
  const exact = db.isDispatchProcessCurrent({
    dispatchId,
    paneKey: structured.paneKey,
    processIncarnation: structured.processIncarnation
  })
  // Status and addressability judge the same conversation, including during clear.
  const hold = holdStructuredWorker(structured, db)
  const observation =
    hold.kind === 'unverifiable'
      ? { status: 'unverifiable' as const, reason: hold.reason }
      : observeStructuredSession(hold.running.sessionId)
  const addressable = hold.kind === 'unverifiable' ? null : hold.kind === 'held'
  return {
    terminal: null,
    exact,
    status: exact ? observation.status : 'identity_changed',
    ...(exact && observation.reason ? { reason: observation.reason } : {}),
    ...(exact && addressable !== null ? { addressable } : {}),
    terminalHandle: null
  }
}

/** A fleet page's chat verdicts, read off the session records a restart leaves uninstalled. */
export async function chatAssigneeObserver(
  runtime: Pick<OrcaRuntimeService, 'ensureStructuredAgentSessionHost'>,
  db: OrchestrationDb,
  rows: readonly { agentTerminalHandle: string | null }[]
): Promise<(sessionId: OrcaSessionId) => ChatAssigneeObservation> {
  if (rows.some((row) => chatAssigneeSessionId(row.agentTerminalHandle))) {
    await runtime.ensureStructuredAgentSessionHost().catch(() => undefined)
  }
  return (sessionId) => observeChatAssignee(sessionId, db)
}
