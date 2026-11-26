import { insertJournalDomainImportedSubmission } from './journal-domain-import-submissions'
import {
  JOURNAL_DOMAIN_ITEM_COLUMNS,
  journalDomainItemColumns
} from './journal-domain-item-read-columns'
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
import { writeJournalDomainItemNames } from './journal-domain-item-names'
import { JournalSqlBatch } from './journal-sql-batch'
import { JournalSqlCommand } from './journal-sql-command'
import type { JournalWriterCommand } from './journal-writer-command'
import type { JournalWriterCommit } from './journal-writer-changes'
import type { JournalSqlMessage } from './journal-sql-message-commit'

export const target = { sessionId: 'chat', epoch: 'epoch', ownerToken: 'owner' }
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
    `INSERT INTO journal_chat_state(workspace_id,session_id,epoch,last_sequence,highest_fence) VALUES('workspace',?,?,10,1)`
  ).run(target.sessionId, target.epoch)
  const batch = new JournalSqlBatch(db)
  const published: JournalWriterCommit[] = []
  const command = (
    steps: readonly JournalSqlMessage[],
    destination = target
  ): JournalWriterCommand => ({
    target: destination,
    operation: {
      kind: 'steps',
      steps: steps.map((step) => {
        const reservedBytes = Buffer.byteLength(JSON.stringify(step)) + 512
        return step.kind === 'text-snapshot'
          ? {
              kind: 'resolved-item',
              resolution: { kind: 'text-snapshot', identity: step.identity, body: step.body },
              options: step.options,
              reservedBytes
            }
          : { ...step, reservedBytes }
      })
    }
  })
  const commitCommands = async (commands: readonly JournalWriterCommand[], savedAt = 100) => {
    const result = await batch.run(commands, (command) =>
      new JournalSqlCommand(db, '').apply(command, savedAt)
    )
    for (const outcome of result.outcomes) {
      if (outcome.committed) {
        published.push(outcome.value)
      }
    }
    return result
  }
  const commit = (...steps: JournalSqlMessage[]) => commitCommands([command(steps)])
  const item = (itemId: string): AgentJournalRenderItem | undefined => {
    const row = db.prepare('SELECT payload_json FROM journal_items WHERE item_id=?').get(itemId)
    return row ? JSON.parse(String(row.payload_json)) : undefined
  }
  const seedItem = (item: AgentJournalRenderItem) => {
    const payload = JSON.stringify(item)
    const { metadata, values } = journalDomainItemColumns(item, payload)
    db.prepare(`INSERT INTO journal_items
    (session_id,epoch,item_id,ordinal,revision,sequence,sequence_index,owner_fence,payload_json,
     placement_json,${JOURNAL_DOMAIN_ITEM_COLUMNS.join(',')})
     VALUES(${Array.from({ length: 10 + JOURNAL_DOMAIN_ITEM_COLUMNS.length }, () => '?').join(',')})`).run(
      target.sessionId,
      target.epoch,
      item.itemId,
      item.sequence,
      item.revision,
      item.sequence,
      item.sequenceIndex ?? 0,
      1,
      payload,
      journalDomainItemPlacement(item),
      ...values
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
    insertJournalDomainImportedSubmission(db, target, {
      submission,
      sequence: 1,
      index: 0,
      ordinal: 1,
      candidate: true,
      admittedPersonal: true,
      echoObserved: false,
      admission: {
        body,
        providerHandle: null,
        fence: 1,
        scope: null,
        familyId: null,
        origin: 'client',
        sourceKind: 'user',
        options: null
      },
      handover: null,
      handoverPlace: null,
      carries: [],
      rejection: null,
      presentationMember: false,
      normalizedHandOff: false,
      ended: false
    })
  }
  return { db, batch, published, command, commitCommands, commit, item, seedItem, seedSend }
}
