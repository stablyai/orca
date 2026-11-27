import { expect, it, vi } from 'vitest'
import Database from '../../sqlite/sync-database'
import { agentSessionFailureFact } from '../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session/failures/agent-session-failure-words'
import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { ensureAgentSessionAttachmentClaimTables } from '../agent-session-attachments/agent-session-attachment-claims'
import { applyJournalDomainControlCommand } from './journal-domain-control-command'
import { applyJournalDomainItem, type JournalDomainItemWrite } from './journal-domain-item'
import { migrateJournalDomainSchema } from './journal-domain-schema'
import { readJournalSqlQueue } from './journal-sql-queue-read'
import { JournalSqlScope } from './journal-sql-scope'

// #49876: Exit release reads the active usage-limit row and skips a failure lifted by Resume.
it.each([128, 1_280])('reads one usage-limit candidate among %i status rows', (count) => {
  const db = new Database(':memory:')
  const target = { sessionId: 'chat', epoch: 'epoch' }
  const now = 1_800_000_000_000
  const turn = { provider: 'orca' as const, clientMessageId: 'failed-turn' }
  const turnScope = { kind: 'turn' as const, turnItemId: agentJournalItemKey(turn) }
  const append = (item: JournalDomainItemWrite) => applyJournalDomainItem(db, target, item, now)
  const mailHold = () =>
    readJournalSqlQueue(new JournalSqlScope(db, target.sessionId, target.epoch), {
      kind: 'failure-holds',
      facts: { reopenFloor: null }
    })
  try {
    migrateJournalDomainSchema(db)
    ensureAgentSessionAttachmentClaimTables(db)
    db.prepare(`INSERT INTO journal_chat_state(session_id,workspace_id,epoch,last_sequence,highest_fence)
      VALUES('chat','workspace','epoch',0,1)`).run()
    db.exec('BEGIN IMMEDIATE')
    append({
      kind: 'item',
      identity: turn,
      body: { kind: 'turn', turnId: 'failed-turn', state: 'completed', outcome: 'failure' },
      options: { fence: 1, turnScope: { kind: 'thread' } }
    })
    for (let index = 0; index < count; index++) {
      append({
        kind: 'item',
        identity: { provider: 'orca', clientMessageId: `status-${index}` },
        body: { kind: 'status', tone: 'info', text: `Working ${index}` },
        options: { fence: 1, turnScope }
      })
    }
    append({
      kind: 'item',
      identity: { provider: 'orca', clientMessageId: 'usage-limit' },
      body: {
        kind: 'status',
        ...agentSessionFailureWords(
          agentSessionFailureFact('usageLimitReached', { usageLimit: { resetsAt: now + 60_000 } }),
          { surface: 'row' }
        )
      },
      options: { fence: 1, turnScope }
    })
    const statements = vi.spyOn(db, 'prepare')
    const statusReads = () =>
      statements.mock.calls.filter(([sql]) => sql.includes("kind='status' AND turn_item_id=?"))
    expect(mailHold()).toEqual({ kind: 'failure-holds', held: true })
    expect(statusReads()).toHaveLength(1)
    applyJournalDomainControlCommand(db, target, { kind: 'queue-resume', fence: 1 }, {}, now)
    db.exec('COMMIT')

    statements.mockClear()
    expect(mailHold()).toEqual({ kind: 'failure-holds', held: false })
    expect(statusReads()).toHaveLength(0)
  } finally {
    db.close()
  }
})
