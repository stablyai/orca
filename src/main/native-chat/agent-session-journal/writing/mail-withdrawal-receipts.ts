import { randomUUID } from 'node:crypto'
import type Database from '../../../sqlite/sync-database'
import type { AgentJournalMessageItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { orchestrationMailNotice } from '../../../../shared/agent-session/agent-session-message-source'
import {
  createStructuredAgentSessionOperationId,
  structuredAgentSessionDomainFingerprint,
  structuredAgentSessionPayloadFingerprint
} from '../../../../shared/agent-session/lifecycle/structured-agent-session-mutation'
import type { JournalMailAttempt } from '../journal-mail-observation'
import { commandReceiptSchema } from './command-receipt-schema'
import { insertCommandReceiptIfAbsent } from './command-receipt-table'

const METHOD = 'agentSession.queuedMessageDelete'
const SYSTEM_CALLER = 'trusted-local:orchestration:mail-withdrawal:'

export function mailWithdrawalCaller(attempt: JournalMailAttempt, epoch: string): string {
  return (
    SYSTEM_CALLER +
    structuredAgentSessionDomainFingerprint({
      domain: 'orchestration-mail-withdrawal',
      sessionId: attempt.session_id,
      fields: {
        mailbox: attempt.mailbox_handle,
        message: attempt.message_id,
        session: attempt.session_id,
        operation: attempt.operation_id,
        epoch
      }
    })
  )
}

export function isSystemMailWithdrawalCaller(callerKey: string, sessionId: string): boolean {
  return callerKey === `trusted-local:orchestration:session:${sessionId}`
}

function deleteFingerprint(sessionId: string, messageId: string) {
  return structuredAgentSessionPayloadFingerprint({
    method: METHOD,
    sessionId,
    fields: { messageId }
  })
}

/** Only the writer's actually changed mail card can mint deletion evidence. */
export function recordSystemMailWithdrawal(
  db: Database.Database,
  target: { sessionId: string; epoch: string },
  card: { messageId: string; body: AgentJournalMessageItem },
  now: number
): void {
  const mail = orchestrationMailNotice(card.body.from)
  if (!mail) {
    return
  }
  for (const message of mail.messages) {
    const callerKey = mailWithdrawalCaller(
      {
        mailbox_handle: mail.mailbox,
        message_id: message.messageId,
        session_id: target.sessionId,
        operation_id: card.messageId
      },
      target.epoch
    )
    const receipt = {
      operationId: createStructuredAgentSessionOperationId(randomUUID, now),
      sessionId: target.sessionId,
      callerKey,
      method: METHOD,
      fingerprint: deleteFingerprint(target.sessionId, card.messageId),
      status: 'accepted' as const,
      acceptedAt: now,
      result: { kind: 'queued-draft' as const, messageId: card.messageId }
    }
    const written = insertCommandReceiptIfAbsent(db, { kind: 'caller', callerKey }, receipt)
    if (!written.inserted) {
      throw new Error('system mail withdrawal receipt did not commit')
    }
  }
}

export function readMailWithdrawal(
  db: Database.Database,
  attempt: JournalMailAttempt,
  epoch: string
): 'system' | 'person' | 'unknown' {
  const callerKey = mailWithdrawalCaller(attempt, epoch)
  const fingerprint = deleteFingerprint(attempt.session_id, attempt.operation_id)
  try {
    const select = `SELECT operation_id,session_id,caller_key,method,fingerprint,status,
      result_json,rejection_json,accepted_at FROM agent_session_command_receipts`
    const scoped = db.prepare(`${select} WHERE caller_key=?`).all(callerKey)
    const legacy = db
      .prepare(`${select}
      WHERE session_id=? AND method=? AND fingerprint=? AND caller_key<>?`)
      .all(attempt.session_id, METHOD, fingerprint, callerKey)
    const causes = new Set<'system' | 'person'>()
    for (const row of [...scoped, ...legacy]) {
      if (
        (row.status === 'accepted' && row.rejection_json !== null) ||
        (row.status === 'rejected' && row.result_json !== null)
      ) {
        return 'unknown'
      }
      const parsed = commandReceiptSchema.safeParse({
        operationId: row.operation_id,
        sessionId: row.session_id,
        callerKey: row.caller_key,
        method: row.method,
        fingerprint: row.fingerprint,
        status: row.status,
        acceptedAt: row.accepted_at,
        ...(row.status === 'accepted'
          ? { result: JSON.parse(String(row.result_json)) }
          : { rejection: JSON.parse(String(row.rejection_json)) })
      })
      if (!parsed.success) {
        return 'unknown'
      }
      const receipt = parsed.data
      if (
        receipt.sessionId !== attempt.session_id ||
        receipt.method !== METHOD ||
        receipt.fingerprint !== fingerprint
      ) {
        return 'unknown'
      }
      if (receipt.status !== 'accepted' || receipt.result.kind !== 'queued-draft') {
        continue
      }
      if (receipt.result.messageId !== attempt.operation_id) {
        return 'unknown'
      }
      if (receipt.callerKey.startsWith(SYSTEM_CALLER) && receipt.callerKey !== callerKey) {
        continue
      }
      if (
        receipt.callerKey === callerKey ||
        isSystemMailWithdrawalCaller(receipt.callerKey, attempt.session_id)
      ) {
        causes.add('system')
      } else if (
        ['trusted-local:runtime', 'trusted-local:desktop', 'trusted-local:mobile'].includes(
          receipt.callerKey
        ) ||
        !receipt.callerKey.startsWith('trusted-local:')
      ) {
        // Public deletes store their authenticated device/client namespace, including explicit CLI deletes.
        causes.add('person')
      } else {
        return 'unknown'
      }
    }
    return causes.size === 1 ? [...causes][0]! : 'unknown'
  } catch {
    return 'unknown'
  }
}
