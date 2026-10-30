import { QueuedMessageEditLeases } from './queued-message-edit-leases'
import {
  queuedMessageUpdateDecision as decideUpdate,
  type QueuedMessageUpdate
} from './queued-message-update'
import type { QueuedMessageRow } from './queued-message-table'
import type { QueuedEditHostFixtureModule } from '../../../shared/queued-edit-host.test-fixture'
import { agentSessionSendBodyFingerprint } from '../../../shared/structured-agent-session-send-mutation'

/** Real CAS/lease decisions; delivery of their answers is controlled by the client harness. */
export const queuedEditHost: QueuedEditHostFixtureModule['queuedEditHost'] = (
  sessionId,
  message
) => {
  let row: QueuedMessageRow | null = {
    ...message,
    fingerprint: agentSessionSendBodyFingerprint(sessionId, message.body),
    holdReason: null,
    returnedReason: null,
    returnedRejection: null,
    consumedAs: null,
    queuedAt: null
  }
  const leases = new QueuedMessageEditLeases(() => (row ? [row] : []))
  const update = (input: QueuedMessageUpdate) => {
    const result = decideUpdate(row, sessionId, input)
    if (result.status !== 'ready') {
      return result
    }
    if (!row) {
      throw new Error('missing row')
    }
    row = { ...row, body: result.body, fingerprint: result.fingerprint }
    leases.retire(message.messageId)
    return {
      status: 'updated' as const,
      messageId: message.messageId,
      fingerprint: result.fingerprint
    }
  }
  return {
    leases,
    update,
    get row() {
      return row
    },
    depart: () => {
      row = null
    },
    acquire: (editId: string, expected: string) =>
      leases.acquire(
        { callerKey: 'client', editId },
        { messageId: message.messageId, fingerprint: expected }
      )
  }
}

export const queuedMessageUpdateDecision: QueuedEditHostFixtureModule['queuedMessageUpdateDecision'] =
  decideUpdate
