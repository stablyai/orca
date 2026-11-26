import { expect, it, vi } from 'vitest'
import Database from '../../sqlite/sync-database'
import { ensureAgentSessionAttachmentClaimTables } from '../agent-session-attachments/agent-session-attachment-claims'
import { connectorAskerPrompt } from '../../../shared/connector-asker-prompt'
import * as promptProjection from '../../../shared/agent-session/requests/structured-agent-session-latest-request'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { applyJournalDomainItem } from './journal-domain-item'
import { migrateJournalDomainSchema } from './journal-domain-schema'
import { JournalSqlScope } from './journal-sql-scope'
import { JournalSqlStatusContext } from './journal-sql-status-context'
import { readJournalSqlRequestStatus } from './journal-sql-status-requests'

function slackPrompt(prefix: string): AgentJournalMessageItem {
  return {
    kind: 'message',
    role: 'user',
    origin: 'connector',
    blocks: [
      {
        type: 'text',
        text: connectorAskerPrompt('slack', {
          userId: 'U1',
          name: 'Fixture',
          role: 'owner',
          place: { kind: 'public_channel', id: 'C1' },
          context: [],
          text: prefix + 'x'.repeat(64 * 1024)
        })
      },
      { type: 'image-ref', path: '/fixture/image.png' }
    ]
  }
}

it.each([10, 100])('does not unpack unchanged requests across updates to %d chats', (chats) => {
  const db = new Database(':memory:')
  const format = vi.spyOn(promptProjection, 'latestStructuredAgentSessionPrompt')
  const epoch = 'fixture-epoch'
  const sessionIds = Array.from({ length: chats }, (_, index) => `chat-${index}`)
  let now = 1_800_000_000_000
  const write = (sessionId: string, id: string, body: AgentJournalMessageItem) =>
    applyJournalDomainItem(
      db,
      { sessionId, epoch },
      {
        kind: 'item',
        identity: { provider: 'orca', clientMessageId: id },
        body,
        options: { turnScope: { kind: 'thread' }, fence: 1 }
      },
      now++
    )
  const read = (sessionId: string) =>
    readJournalSqlRequestStatus(
      new JournalSqlStatusContext(new JournalSqlScope(db, sessionId, epoch))
    )
  try {
    migrateJournalDomainSchema(db)
    ensureAgentSessionAttachmentClaimTables(db)
    db.exec('BEGIN IMMEDIATE')
    const start = db.prepare(`INSERT INTO journal_chat_state(
      session_id,workspace_id,epoch,last_sequence,highest_fence
    ) VALUES(?,'workspace',?,0,1)`)
    for (const sessionId of sessionIds) {
      start.run(sessionId, epoch)
      write(sessionId, 'prompt', slackPrompt('First request '))
      expect(read(sessionId).latestPrompt).toMatch(/^First request /)
    }
    expect(format).toHaveBeenCalledTimes(chats)
    format.mockClear()

    for (const sessionId of sessionIds) {
      write(sessionId, 'assistant', {
        kind: 'message',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'My response' }]
      })
      expect(read(sessionId).latestPrompt).toMatch(/^First request /)
    }
    expect(format).not.toHaveBeenCalled()

    const first = sessionIds[0]!
    write(first, 'next-prompt', slackPrompt('New request '))
    expect(read(first).latestPrompt).toMatch(/^New request /)
    expect(format).toHaveBeenCalledTimes(1)
    db.exec('COMMIT')
  } finally {
    format.mockRestore()
    db.close()
  }
})
