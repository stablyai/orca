import { createHash } from 'node:crypto'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { readAgentJournalTurn } from '../../../../shared/agent-session/lifecycle/agent-session-turn-record'
import { structuredAgentSessionPayloadFingerprint } from '../../../../shared/agent-session/lifecycle/structured-agent-session-mutation'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { mintAgentSessionOperationId } from '../structured-pointer-operation-id'
import type { SessionLinkStore } from './session-link-store'

export async function stopSessionLinkTurns(
  store: SessionLinkStore,
  id: string,
  operationId: string
): Promise<void> {
  const host = getStructuredAgentSessionHost()
  if (!host) {
    return
  }
  const link = store.get(id)
  await Promise.all(
    link.participants.map(async (participant) => {
      const sessionId = participant.sessionId
      const record = host.deps.store.getConversation(sessionId)
      if (!record) {
        return
      }
      const snapshot = await host.journalSnapshot(sessionId)
      const turn = host.currentWork(sessionId)?.activeTurn()
      const userItemId = readAgentJournalTurn(turn?.item.body)?.userItemId
      const ownTurn = store
        .events(id)
        .some(
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
      const eventId = createHash('sha256')
        .update(JSON.stringify([id, operationId, sessionId, 'stop']))
        .digest('hex')
      const previous = store.event(eventId)
      if (!turn || !ownTurn) {
        if (!previous) {
          store.write({
            id: eventId,
            linkId: id,
            actor: 'host',
            recipient: sessionId,
            kind: 'control',
            messageId: null,
            replyTo: null,
            state: 'recorded',
            operationId: '',
            createdAt: Date.now(),
            body: '',
            detail: turn ? 'stop-unrelated-turn' : 'stop-unconfirmed'
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
        id: eventId,
        linkId: id,
        actor: 'host',
        recipient: sessionId,
        kind: 'control' as const,
        messageId: null,
        replyTo: null,
        state: 'recorded' as const,
        operationId: clientOperationId,
        targetTurnId: turn.turnId,
        createdAt: previous?.createdAt ?? Date.now(),
        body: '',
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
