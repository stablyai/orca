import { journalDomainItemReadColumns } from './journal-domain-item-read-columns'
import { journalDomainItemPlacement } from './journal-domain-item-placement'
import Database from '../../sqlite/sync-database'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission,
  AgentJournalMessageItem
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { agentSessionSendBodyFingerprint } from '../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import { migrateJournalDomainSchema } from './journal-domain-schema'
import { journalDomainHistoryMetadata } from './journal-domain-history-metadata'
import { writeJournalDomainItemNames } from './journal-domain-item-names'
import { JournalSqlBatch } from './journal-sql-batch'
import {
  commitJournalSqlMessages,
  prepareJournalSqlMessages,
  type JournalSqlMessagesCommit
} from './journal-sql-message-commit'
import type { JournalSqlMessage } from './journal-sql-message-commit'

export const target = { sessionId: 'chat', epoch: 'epoch' }
export function message(
  text: string,
  clientMessageId = 'assistant',
  kind: JournalSqlMessage['kind'] = 'text-snapshot'
): JournalSqlMessage {
  return {
    kind,
    identity: { provider: 'orca', clientMessageId },
    body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] },
    options: { fence: 1, turnScope: { kind: 'thread' } }
  }
}

export function messageFixture(db = new Database(':memory:')) {
  migrateJournalDomainSchema(db)
  db.prepare(
    `INSERT INTO journal_chat_state(session_id,epoch,last_sequence,highest_fence) VALUES(?,?,10,1)`
  ).run(target.sessionId, target.epoch)
  const batch = new JournalSqlBatch(db)
  const published: JournalSqlMessagesCommit[] = []
  const commit = (...steps: JournalSqlMessage[]) =>
    commitJournalSqlMessages(
      db,
      batch,
      [prepareJournalSqlMessages({ target, steps, savedAt: 100 })],
      (result) => {
        if (db.isTransaction) {
          throw new Error('publication preceded commit')
        }
        published.push(result)
      }
    )
  const item = (itemId: string): AgentJournalRenderItem | undefined => {
    const row = db.prepare('SELECT payload_json FROM journal_items WHERE item_id=?').get(itemId)
    return row ? JSON.parse(String(row.payload_json)) : undefined
  }
  const seedItem = (item: AgentJournalRenderItem) => {
    const payload = JSON.stringify(item)
    const metadata = journalDomainHistoryMetadata(item, payload)
    db.prepare(`INSERT INTO journal_items
    (session_id,epoch,item_id,ordinal,revision,sequence,sequence_index,owner_fence,payload_json,
     root,subagent_row,subagent_group_key,turn_marker,wire_bytes,placement_json,kind,message_role,turn_id,opener_item_id,context_clear,goal_transition,producer_agent_id,producer_parent_ref,producer_attempt,prompt,signed_out) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      target.sessionId,
      target.epoch,
      item.itemId,
      item.sequence,
      item.revision,
      item.sequence,
      item.sequenceIndex ?? 0,
      1,
      payload,
      metadata.root,
      metadata.subagentRow,
      metadata.subagentGroupKey,
      metadata.turnMarker,
      metadata.wireBytes,
      journalDomainItemPlacement(item),
      ...journalDomainItemReadColumns(item)
    )
    writeJournalDomainItemNames(
      db,
      target,
      item,
      { ordinal: item.sequence, hidden: false },
      metadata.namedSubagentIds
    )
  }
  const seedSend = () => {
    const body: AgentJournalMessageItem = {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'original' }]
    }
    const submission: AgentJournalSubmission = {
      clientMessageId: 'send',
      fence: 1,
      payloadFingerprint: agentSessionSendBodyFingerprint('chat', body),
      dispatchState: 'unknown',
      providerItemId: null,
      reason: 'waiting',
      resolvedAt: null,
      submittedAt: 1,
      submittedSequence: 1,
      acceptedSequence: 1,
      handoverRecorded: true,
      origin: 'client',
      recovered: true
    }
    const itemId = agentJournalSubmissionKey('send')
    seedItem({
      itemId,
      revision: 0,
      sequence: 7,
      observedAt: 70,
      body: { ...body, blocks: [...body.blocks] },
      turnScope: { kind: 'thread' }
    })
    db.prepare(`INSERT INTO journal_submission_attempts(session_id,epoch,message_id,attempt_sequence,attempt_index,current,item_id,ordinal,submitted_at,accepted_sequence,fingerprint,dispatch_state,candidate,admitted_personal,payload_json)
      VALUES(?,?,?,1,0,1,?,1,1,1,?,'unknown',1,1,?)`).run(
      'chat',
      'epoch',
      'send',
      itemId,
      submission.payloadFingerprint,
      JSON.stringify(submission)
    )
    return submission
  }
  return { db, batch, published, commit, item, seedItem, seedSend }
}
