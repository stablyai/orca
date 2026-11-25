import { expect, it, vi } from 'vitest'
import Database from '../../sqlite/sync-database'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { migrateJournalDomainSchema } from './journal-domain-schema'
import { readJournalDomainSubmissionAttempt } from './journal-domain-submission-records'
import { JournalSqlCommand } from './journal-sql-command'
import type { JournalWriterOperation } from './journal-writer-command'

// PR #45057: recording a receipt used to decode the entire prompt twice on the shared writer.
it.each([64, 640])('records a receipt without decoding the %i KiB prompt', async (sizeKiB) => {
  const db = new Database(':memory:')
  try {
    const now = 1_800_000_000_000
    const target = { sessionId: 'chat', epoch: 'epoch', ownerToken: 'owner' }
    const writer = new JournalSqlCommand(db, '')
    migrateJournalDomainSchema(db)
    db.prepare(`INSERT INTO journal_chat_state(session_id,workspace_id,epoch,last_sequence,highest_fence)
      VALUES('chat','workspace','epoch',10,1)`).run()
    const apply = async (operation: JournalWriterOperation, savedAt: number) => {
      db.exec('BEGIN IMMEDIATE')
      try {
        const result = await writer.apply(
          {
            target,
            operation,
            facts: {
              identity: {
                sessionId: 'chat',
                workspaceId: 'workspace',
                hostId: 'host',
                agent: 'claude',
                providerHandle: null
              }
            }
          },
          savedAt
        )
        db.exec('COMMIT')
        return result
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    }
    const marker = 'receipt-performance-prompt'
    const prompt = marker.padEnd(sizeKiB * 1024, 'x')
    const body: AgentJournalMessageItem = {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: prompt }]
    }
    await apply(
      {
        kind: 'submission',
        input: {
          clientMessageId: 'send',
          body,
          payloadFingerprint: 'prompt',
          fence: 1,
          origin: 'client',
          source: { kind: 'user' },
          handoverRecorded: true
        }
      },
      now
    )
    const pending = await apply(
      {
        kind: 'dispatch',
        input: {
          clientMessageId: 'send',
          fence: 1,
          state: 'pending',
          turnScope: { kind: 'thread' }
        }
      },
      now + 1
    )
    const parse = vi.spyOn(JSON, 'parse')
    const promptDecodes = () => parse.mock.calls.filter(([text]) => text.includes(marker)).length
    try {
      const receipt = await apply(
        {
          kind: 'dispatch-written',
          clientMessageId: 'send',
          fence: 1,
          providerReceipt: true,
          observedAt: now + 2
        },
        now + 3
      )
      expect(promptDecodes()).toBe(0)
      expect(receipt).toMatchObject({
        cursor: { epoch: target.epoch, sequence: pending.cursor.sequence + 1 },
        inputChanged: false,
        requestEvents: [],
        publication: { writtenOnly: true, items: [] }
      })
      const stored = readJournalDomainSubmissionAttempt(db, target, 'send')
      expect(stored?.submission).toMatchObject({ dispatchState: 'pending', writtenAt: now + 2 })
      expect(promptDecodes()).toBe(1)
      expect(stored?.admission.body).toEqual(body)
    } finally {
      parse.mockRestore()
    }
  } finally {
    db.close()
  }
})
