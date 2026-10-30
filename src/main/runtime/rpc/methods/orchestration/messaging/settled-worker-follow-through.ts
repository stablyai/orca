import { parseOrcaSessionAddress } from '../../../../../../shared/orca-session-address'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import type { OrchestrationSessionCaller } from '../../../../orchestration/orchestration-caller-identity'
import { resolveOrcaSessionParty } from '../../../../orchestration/orchestration-party'
import { readStructuredAgentSessionRecord } from '../../../../structured-worker-authority'
import { sendWorkerFollowUp } from './worker-follow-up'

/** Mail the worker never read before it reported is not lost: it becomes the worker's next Task, as a send after the report would. */
export function followUpUnreadCoordinatorMail(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  dispatchId: string
): void {
  const unread = db.getUnreadMessages(`dispatch:${dispatchId}`, ['status', 'dispatch', 'handoff'])
  const first = unread[0]
  if (!first) {
    return
  }
  const sessionId = parseOrcaSessionAddress(first.from_handle)
  const record = sessionId ? readStructuredAgentSessionRecord(sessionId) : null
  const orchestrationCaller: OrchestrationSessionCaller | undefined =
    sessionId && record
      ? {
          ...resolveOrcaSessionParty(sessionId, db),
          sessionId,
          workspaceId: record.location.workspaceId
        }
      : undefined
  void sendWorkerFollowUp({
    ctx: { runtime, orchestrationCaller },
    db,
    dispatchId,
    from: first.from_handle,
    type: first.type,
    subject: unread.length === 1 ? first.subject : `${first.subject} (+${unread.length - 1} more)`,
    body: unread.map((message) => message.body || message.subject).join('\n\n')
  }).then(
    (outcome) => {
      if (outcome?.kind === 'started') {
        db.markAsReadAndDelivered(unread.map((message) => message.id))
      }
    },
    (error: unknown) => {
      console.warn('[orchestration] unread mail did not become a follow-up', dispatchId, error)
    }
  )
}
