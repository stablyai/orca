import type Database from '../../sqlite/sync-database'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { journalDomainHistoryMetadata } from './journal-domain-history-metadata'
import { insertJournalDomainQueueRow, journalDomainQueueRow } from './journal-domain-queue-rows'
import type { JournalDomainImportHeader, JournalDomainImportPage } from './journal-domain-import'

export type JournalDomainImportState =
  | { state: 'converting'; epoch: null }
  | { state: 'ready'; epoch: string }

/**
 * A chat's head row is its ready mark: once written, domain state wins and the frozen source is
 * never read again. An unready chat imports the original under the profile lock.
 */
export function journalDomainImportState(
  db: Database.Database,
  sessionId: string
): JournalDomainImportState {
  const ready = db.prepare('SELECT epoch FROM journal_chat_state WHERE session_id=?').get(sessionId)
  if (ready) {
    return { state: 'ready', epoch: String(ready.epoch) }
  }
  return { state: 'converting', epoch: null }
}

/**
 * One page in the writer transaction. Rows keep their restored identities, so a restarted import
 * rewrites nothing it already inserted; a ready chat's rows are never touched from source.
 */
export function insertJournalDomainImportPage(
  db: Database.Database,
  target: Pick<JournalDomainImportHeader, 'sessionId' | 'epoch'>,
  page: JournalDomainImportPage
): boolean {
  if (!db.isTransaction) {
    throw new Error('journal domain import requires its writer transaction')
  }
  if (db.prepare('SELECT 1 FROM journal_chat_state WHERE session_id=?').get(target.sessionId)) {
    return false
  }
  const prefix = [target.sessionId, target.epoch] as const
  switch (page.kind) {
    case 'items': {
      const insert =
        db.prepare(`INSERT INTO journal_items(session_id,epoch,item_id,ordinal,revision,
        sequence,sequence_index,owner_fence,execution_owner,payload_json,hidden,root,subagent_row,
        subagent_group_key,named_subagent_ids,turn_marker)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`)
      for (const { ordinal, ownerFence, executionOwner, hidden, item } of page.rows) {
        const metadata = journalDomainHistoryMetadata(item)
        insert.run(
          ...prefix,
          item.itemId,
          ordinal,
          item.revision,
          item.sequence,
          item.sequenceIndex ?? 0,
          ownerFence,
          executionOwner,
          JSON.stringify(item),
          Number(hidden),
          metadata.root,
          metadata.subagentRow,
          metadata.subagentGroupKey,
          metadata.namedSubagentIds,
          metadata.turnMarker
        )
      }
      break
    }
    case 'tombstones': {
      const insert =
        db.prepare(`INSERT INTO journal_item_tombstones(session_id,epoch,item_id,revision)
        VALUES(?,?,?,?) ON CONFLICT DO NOTHING`)
      for (const { itemId, revision } of page.rows) {
        insert.run(...prefix, itemId, revision)
      }
      break
    }
    case 'aliases': {
      const insert = db.prepare(`INSERT INTO journal_item_aliases(session_id,epoch,provider_item_id,
        item_id,echo_declared,echo_json) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING`)
      for (const { providerItemId, itemId, echo } of page.rows) {
        insert.run(
          ...prefix,
          providerItemId,
          itemId,
          Number(echo !== undefined),
          echo ? JSON.stringify(echo.value ?? null) : null
        )
      }
      break
    }
    case 'attempts': {
      const insert =
        db.prepare(`INSERT INTO journal_submission_attempts(session_id,epoch,message_id,
        attempt_sequence,attempt_index,current,item_id,ordinal,submitted_at,accepted_sequence,
        fingerprint,dispatch_state,candidate,admitted_personal,payload_json)
        VALUES(?,?,?,?,0,1,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`)
      for (const { ordinal, candidate, admittedPersonal, submission } of page.rows) {
        insert.run(
          ...prefix,
          submission.clientMessageId,
          submission.submittedSequence ?? 0,
          agentJournalSubmissionKey(submission.clientMessageId),
          ordinal,
          submission.submittedAt,
          submission.acceptedSequence ?? null,
          submission.payloadFingerprint,
          submission.dispatchState,
          Number(candidate),
          Number(admittedPersonal),
          JSON.stringify(submission)
        )
      }
      break
    }
    case 'receipts': {
      const insert =
        db.prepare(`INSERT INTO journal_send_receipts(session_id,epoch,message_id,payload_json)
        VALUES(?,?,?,?) ON CONFLICT DO NOTHING`)
      for (const receipt of page.rows) {
        insert.run(...prefix, receipt.clientMessageId, JSON.stringify(receipt))
      }
      break
    }
    case 'cards':
      for (const card of page.rows) {
        if (!journalDomainQueueRow(db, target, card.messageId)) {
          insertJournalDomainQueueRow(db, target, card)
        }
      }
      break
    case 'activity': {
      const insert =
        db.prepare(`INSERT INTO journal_provider_activity(session_id,epoch,fence,last_activity_at)
        VALUES(?,?,?,?) ON CONFLICT DO NOTHING`)
      for (const { fence, lastActivityAt } of page.rows) {
        insert.run(...prefix, fence, lastActivityAt)
      }
      break
    }
  }
  return true
}

/**
 * Written after every page: the head marks the chat ready. No replay events exist for imported
 * history, so the retained boundary is the head and any older cursor takes a snapshot reset.
 */
export function finishJournalDomainImport(
  db: Database.Database,
  header: JournalDomainImportHeader
): string {
  if (!db.isTransaction) {
    throw new Error('journal domain import requires its writer transaction')
  }
  const { head } = header
  db.prepare(`INSERT INTO journal_chat_state(session_id,epoch,last_sequence,retained_sequence,
    highest_fence,context_boundary,last_activity_at) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(session_id) DO NOTHING`).run(
    header.sessionId,
    header.epoch,
    head.lastSequence,
    head.lastSequence,
    head.highestFence,
    head.contextBoundary,
    head.lastActivityAt
  )
  const state = journalDomainImportState(db, header.sessionId)
  if (state.state !== 'ready') {
    throw new Error('journal domain import did not publish its chat head')
  }
  return state.epoch
}
