import Database from '../../sqlite/sync-database'
import type {
  AgentJournalItemBody,
  AgentJournalMessageItem,
  AgentJournalSubmission
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { runJournalTransaction } from './database/journal-database'
import { migrateJournalDomainSchema } from './journal-domain-schema'
import { writeJournalDomainCurrentItem } from './journal-domain-current-item'
import { insertJournalDomainImportedSubmission } from './journal-domain-import-submissions'
import { readJournalDomainTurnAttribution } from './journal-domain-turn-attribution'
import { JournalSqlScope } from './journal-sql-scope'
import { readJournalSqlPoint } from './journal-sql-point-read'
import { journalSqlReads } from './journal-sql-reads'

// A real journal written row by row: items at chosen sequences, and sends answered in chosen turns.

export const turnRowsTarget = { sessionId: 'chat', epoch: 'epoch' }

export const turnRowsUser = (text: string, deliveryId?: string): AgentJournalMessageItem => ({
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text }],
  ...(deliveryId
    ? {
        connectorDelivery: {
          account: 'slack-bot',
          conversation: { source: 'slack', externalId: 'C1' },
          deliveryId
        }
      }
    : {})
})

/** The journal at head 900. */
export function turnRowsChat(cleanups: (() => void)[]) {
  const target = turnRowsTarget
  const db = new Database(':memory:')
  cleanups.push(() => db.close())
  migrateJournalDomainSchema(db)
  db.prepare(
    `INSERT INTO journal_chat_state(workspace_id,session_id,epoch,last_sequence,highest_fence) VALUES('workspace',?,?,900,1)`
  ).run(target.sessionId, target.epoch)
  const item = (
    itemId: string,
    sequence: number,
    body: AgentJournalItemBody,
    turnItemId?: string
  ) =>
    runJournalTransaction(db, () =>
      writeJournalDomainCurrentItem(db, target, {
        item: {
          itemId,
          revision: 1,
          sequence,
          observedAt: sequence,
          body,
          ...(turnItemId ? { turnScope: { kind: 'turn' as const, turnItemId } } : {})
        },
        ordinal: sequence,
        hidden: false,
        ownerFence: 1
      })
    )
  const alias = (providerItemId: string, itemId: string) =>
    db
      .prepare(
        'INSERT INTO journal_item_aliases(session_id,epoch,provider_item_id,item_id) VALUES(?,?,?,?)'
      )
      .run(target.sessionId, target.epoch, providerItemId, itemId)
  /** A send whose message item is `orca:<id>`, answered in `turnItemId` by `via`. */
  const send = (
    id: string,
    sequence: number,
    body: AgentJournalMessageItem,
    answered: { turnItemId: string; via: 'start' | 'steer' } | null,
    facts: Partial<AgentJournalSubmission> = {}
  ) => {
    item(`orca:${id}`, sequence, body, answered?.via === 'steer' ? answered.turnItemId : undefined)
    const submission: AgentJournalSubmission = {
      clientMessageId: id,
      fence: 1,
      payloadFingerprint: id,
      dispatchState: 'accepted',
      providerItemId: null,
      reason: null,
      resolvedAt: sequence,
      submittedAt: sequence,
      acceptedSequence: sequence,
      ...(answered ? { answeredInTurn: answered } : {}),
      ...facts
    }
    runJournalTransaction(db, () =>
      insertJournalDomainImportedSubmission(db, target, {
        submission,
        sequence,
        index: 0,
        ordinal: sequence,
        candidate: false,
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
        normalizedHandOff: false
      })
    )
  }
  const read = (turnId: string, through = 900) =>
    readJournalDomainTurnAttribution(
      new JournalSqlScope(db, target.sessionId, target.epoch),
      turnId,
      through
    )
  /** The chat's reads, as a reader worker answers them. */
  const reads = journalSqlReads(
    { point: async (request) => readJournalSqlPoint(db, request) },
    target.sessionId
  )
  return { db, item, alias, send, read, reads }
}
