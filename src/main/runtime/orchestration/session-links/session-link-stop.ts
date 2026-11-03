import { createHash } from 'node:crypto'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { readAgentJournalTurn } from '../../../../shared/agent-session/lifecycle/agent-session-turn-record'
import { structuredAgentSessionPayloadFingerprint } from '../../../../shared/agent-session/lifecycle/structured-agent-session-mutation'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { mintAgentSessionOperationId } from '../structured-pointer-operation-id'
import type { SessionLinkStore } from './session-link-store'

export type SessionLinkControlTurn = { sessionId: string; operationId: string }

export async function stopSessionLinkTurns(
  store: SessionLinkStore,
  id: string,
  operationId: string,
  callingTurn?: SessionLinkControlTurn
): Promise<void> {
  const host = getStructuredAgentSessionHost()
  const link = store.get(id)
  await Promise.all(
    link.participants.map(async (participant) => {
      const sessionId = participant.sessionId
      const eventId = createHash('sha256')
        .update(JSON.stringify([id, operationId, sessionId, 'stop']))
        .digest('hex')
      const previous = store.event(eventId)
      const receipt = {
        id: eventId,
        linkId: id,
        actor: 'host',
        recipient: sessionId,
        kind: 'control' as const,
        messageId: null,
        replyTo: null,
        state: 'recorded' as const,
        createdAt: previous?.createdAt ?? Date.now(),
        body: ''
      }
      if (
        previous &&
        previous.detail !== 'stop-pending' &&
        !(previous.detail === 'stop-unconfirmed' && previous.targetTurnId)
      ) {
        return
      }
      if (!host) {
        if (!previous) {
          store.write({ ...receipt, operationId: '', detail: 'stop-unconfirmed' })
        }
        return
      }
      const record = host.deps.store.getConversation(sessionId)
      if (!record) {
        if (!previous) {
          store.write({ ...receipt, operationId: '', detail: 'stop-unconfirmed' })
        }
        return
      }
      const snapshot = await host.journalSnapshot(sessionId)
      const work = host.currentWork(sessionId)
      const turn = work?.activeTurn()
      const userItemId = readAgentJournalTurn(turn?.item.body)?.userItemId
      const events = store.events(id)
      const completedInputs = new Set(
        snapshot.items.flatMap(({ body }) => {
          const completed = readAgentJournalTurn(body)
          return completed?.state === 'completed' && completed.userItemId
            ? [completed.userItemId]
            : []
        })
      )
      const unsettledLinkSend = snapshot.submissions.some(
        (submission) =>
          events.some(
            (event) =>
              event.recipient === sessionId && event.operationId === submission.clientMessageId
          ) &&
          submission.dispatchState !== 'rejected' &&
          !completedInputs.has(agentJournalSubmissionKey(submission.clientMessageId)) &&
          !(submission.providerItemId && completedInputs.has(submission.providerItemId))
      )
      const ownTurn = events.find(
        (event) =>
          event.recipient === sessionId &&
          snapshot.submissions.some(
            (s) =>
              s.clientMessageId === event.operationId &&
              s.dispatchState === 'accepted' &&
              (userItemId === agentJournalSubmissionKey(event.operationId) ||
                (userItemId !== undefined && userItemId === s.providerItemId))
          )
      )
      if (
        callingTurn?.sessionId === sessionId &&
        ownTurn?.operationId === callingTurn.operationId &&
        turn
      ) {
        if (!previous) {
          store.write({
            ...receipt,
            operationId: '',
            targetTurnId: turn.turnId,
            detail: 'stop-calling-turn-kept'
          })
        }
        return
      }
      if (!turn || !ownTurn) {
        if (!previous) {
          store.write({
            ...receipt,
            operationId: '',
            detail: turn
              ? 'stop-unrelated-turn'
              : work && !work.working() && !unsettledLinkSend
                ? 'stop-idle'
                : 'stop-unconfirmed'
          })
        }
        return
      }
      const fields = { turnId: turn.turnId }
      if (previous?.targetTurnId && previous.targetTurnId !== turn.turnId) {
        return
      }
      const clientOperationId = previous?.operationId || mintAgentSessionOperationId(Date.now())
      const intent = {
        ...receipt,
        operationId: clientOperationId,
        targetTurnId: turn.turnId,
        detail: 'stop-pending'
      }
      store.write(intent)
      const result = await host.cancel(
        { callerKey: `trusted-local:session-link:${id}` },
        {
          envelope: {
            sessionId,
            clientOperationId,
            expectedRuntimeFence: record.currentFence,
            payloadFingerprint: structuredAgentSessionPayloadFingerprint({
              method: 'agentSession.cancel',
              sessionId,
              fields
            })
          },
          ...fields
        }
      )
      store.write({
        ...intent,
        detail: result.ok && result.value.cancelled ? 'stop-acknowledged' : 'stop-unconfirmed'
      })
    })
  )
}
