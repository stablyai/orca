import { expect, it, vi } from 'vitest'
import Database from '../../sqlite/sync-database'
import { claudeProviderHandle } from '../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { agentSessionRecordFixture } from '../testing/agent-session-record-test-fixture'
import { ensureAgentSessionAttachmentClaimTables } from '../agent-session-attachments/agent-session-attachment-claims'
import { migrateJournalDomainSchema } from './journal-domain-schema'
import { applyJournalDomainDispatch } from './journal-domain-dispatch'
import { insertJournalDomainQueueRow } from './journal-domain-queue-rows'
import { applyJournalSqlSendAdmission } from './journal-sql-send-admission'

const now = 1_800_000_000_000
const target = { sessionId: 'queue-chat', epoch: 'epoch', ownerToken: 'owner' }

function message(text: string): AgentJournalMessageItem {
  return { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }
}

// PR #45200: once a fresh send lifts the restart pause, skip the waiting-card attempt join.
it('does no interrupted-attempt scan on a follow-up after a fresh person acceptance', () => {
  const db = new Database(':memory:')
  try {
    migrateJournalDomainSchema(db)
    ensureAgentSessionAttachmentClaimTables(db)
    db.exec(`INSERT INTO journal_chat_state(session_id,workspace_id,epoch,last_sequence,highest_fence,queue_reopened_sequence)
      VALUES('queue-chat','workspace','epoch',10,1,10)`)
    db.prepare('INSERT INTO agent_session_records(session_id, record_json) VALUES(?,?)').run(
      target.sessionId,
      JSON.stringify(agentSessionRecordFixture({ sessionId: target.sessionId }))
    )
    db.exec('BEGIN IMMEDIATE')
    for (let index = 0; index < 1_000; index++) {
      const id = `waiting-${index}`
      insertJournalDomainQueueRow(db, target, {
        messageId: id,
        body: message(id),
        position: index + 1,
        fingerprint: id,
        state: 'waiting',
        holdReason: null,
        returnedReason: null,
        returnedRejection: null,
        consumedAs: null,
        queuedAt: { epoch: target.epoch, sequence: 2 }
      })
    }
    const send = (id: string) =>
      applyJournalSqlSendAdmission(
        db,
        '',
        {
          target,
          operation: {
            kind: 'send-admission',
            fromPerson: true,
            fromAgent: false,
            deliveryMode: 'queue',
            input: {
              clientMessageId: id,
              body: message(id),
              payloadFingerprint: id,
              fence: 1,
              origin: 'client',
              source: { kind: 'user' },
              handoverRecorded: true
            }
          },
          facts: {
            identity: {
              sessionId: target.sessionId,
              workspaceId: 'workspace',
              hostId: 'local',
              agent: 'claude',
              providerHandle: claudeProviderHandle('source', null)
            },
            send: {
              handle: 'owner',
              record: null,
              handingOver: [],
              continuingUnadmitted: [],
              finalizing: [],
              openedThrough: { epoch: target.epoch, sequence: 10 },
              operationalRevision: 0
            }
          }
        },
        now
      )
    expect(send('fresh').value).toMatchObject({
      kind: 'admitted',
      value: { submission: { clientMessageId: 'fresh' } }
    })
    applyJournalDomainDispatch(
      db,
      target,
      {
        kind: 'dispatch',
        input: {
          clientMessageId: 'fresh',
          fence: 1,
          state: 'accepted',
          providerIdentity: { provider: 'claude', sessionId: 'source', uuid: 'fresh-echo' }
        }
      },
      now
    )
    const prepare = vi.spyOn(db, 'prepare')
    expect(send('follow-up').value).toMatchObject({
      kind: 'admitted',
      value: { queued: { messageId: 'follow-up' } }
    })
    const attemptJoins = prepare.mock.calls.filter(([sql]) =>
      sql.includes(
        'CROSS JOIN journal_submission_attempts AS attempt INDEXED BY journal_submission_head'
      )
    )
    expect(attemptJoins).toHaveLength(0)
  } finally {
    db.close()
  }
})
