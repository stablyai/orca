import type { OrchestrationDb } from '../../db/orchestration-db'
import { formatReportFollowUpCommand } from '../../../../../shared/orchestration/mailbox/orchestration-report-follow-up'
import { resolveStructuredWorkerIdentityForSession } from '../../terminal-authority/structured-sessions/structured-worker-authority'
import { reportFollowUpAction } from './report-follow-up-action'

/** For a refusal naming a finished worker's chat or terminal: the send that reopens it with new work; empty otherwise. */
export function closedWorkerFollowUpHint(
  db: OrchestrationDb | null | undefined,
  dispatchId: string | null | undefined
): string {
  const action = db && dispatchId ? reportFollowUpAction(db, dispatchId) : undefined
  return action?.kind === 'send' && !action.active
    ? ` To give this worker new work, run \`${formatReportFollowUpCommand(action)}\`; it reopens the same conversation.`
    : ''
}

/** The Dispatch that last held a chat worker, from any session of its conversation. */
export function chatWorkerDispatchId(
  db: OrchestrationDb | null | undefined,
  sessionId: string
): string | undefined {
  const identity = resolveStructuredWorkerIdentityForSession(sessionId, db)
  return identity
    ? db?.getWorkerTerminalResourceByHandle(identity.handle)?.owner_dispatch_id
    : undefined
}
