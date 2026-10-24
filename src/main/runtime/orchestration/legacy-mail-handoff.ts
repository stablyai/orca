import type { StructuredMailboxPointerHost } from './structured-mailbox-pointer-delivery'
import type { OrchestrationDb } from './db'
import { runLifecycleWriteTransaction } from './db/lifecycle-write-transaction-runner'
import { UNKNOWN_MAIL_HANDOFF, type StructuredMailHandoff } from './mail-handoff'
import { mailTransportWasRefused, type StructuredMailEvidence } from './mailbox-settlement'
import type { StructuredPointerOperationRow } from './db/messages/structured-pointer-operation-store'

export function drainLegacyMailHandoff(
  db: OrchestrationDb,
  operation: StructuredPointerOperationRow,
  evidence: StructuredMailEvidence
): void {
  const { legacyNotice: notice, submission } = evidence
  if (!notice || notice.mailbox !== operation.mailbox_handle || !submission) {
    return
  }
  runLifecycleWriteTransaction(db.db, 'legacy_mail_handoff', () => {
    if (
      db.getStructuredPointerOperation(operation.mailbox_handle)?.operation_id !==
      operation.operation_id
    ) {
      return
    }
    const marker = JSON.stringify({
      version: 1,
      kind: 'legacy',
      operationId: operation.operation_id
    })
    const reference: StructuredMailHandoff = {
      version: 1,
      kind: 'structured',
      sessionId: operation.session_id,
      epoch: evidence.epoch,
      frontier: 'legacy',
      operationId: operation.operation_id,
      authorizationId: operation.operation_id,
      clientMessageId: submission.clientMessageId,
      phase: 'reserved',
      nonAdmission: 'refused',
      authority: db.mailboxHandoffAuthority(operation.mailbox_handle)
    }
    const update = db.db.prepare(`UPDATE messages SET handoff = ?
      WHERE id = ? AND to_handle = ? AND read = 0 AND handoff = ?`)
    for (const message of notice.messages) {
      update.run(
        mailTransportWasRefused(evidence) ? JSON.stringify(reference) : UNKNOWN_MAIL_HANDOFF,
        message.messageId,
        operation.mailbox_handle,
        marker
      )
    }
    // Exact recorded members are classified; other pre-upgrade rows were never part of this send.
    db.db
      .prepare('UPDATE messages SET handoff = NULL WHERE to_handle = ? AND handoff = ?')
      .run(operation.mailbox_handle, marker)
    db.deleteStructuredPointerOperation(operation.mailbox_handle)
  })
}

export async function reconcileLegacyMailHandoff(
  db: OrchestrationDb,
  mailbox: string,
  sessionId: string,
  host: StructuredMailboxPointerHost
): Promise<void> {
  const legacy = db.getStructuredPointerOperation(mailbox)
  if (legacy?.session_id === sessionId) {
    const evidence = await host.readHandoffEvidence({
      sessionId,
      clientMessageId: legacy.operation_id
    })
    if (evidence) {
      drainLegacyMailHandoff(db, legacy, evidence)
    }
  }
}
