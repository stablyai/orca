import { join } from 'node:path'
import { expect, it } from 'vitest'
import {
  appendItems,
  body,
  fixture,
  item
} from '../agent-session-wire/publication/history/testing/agent-session-history-contract-test-fixture'
import { openTestJournalHostDatabase } from './store-lifecycle/journal-host-database-test-support'
import { convertJournalSqlProjection } from './journal-sql-conversion'
import { JournalSqlReaderPool } from './journal-sql-reader-pool'
import { journalSqlReaderPath } from './journal-sql-worker-bundle.test-fixture'
import { journalSqlReads } from './journal-sql-reads'
import type { AgentSessionJournalReads } from './journal-reads'
import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'

it('answers every database-shaped read exactly as the in-memory chat does', async () => {
  await appendItems(300)
  const thread = { fence: 1, turnScope: { kind: 'thread' as const } }
  await fixture.journal.appendItem(
    { provider: 'orca', clientMessageId: 'turn-1' },
    { kind: 'turn', turnId: 'turn-1', state: 'running' },
    thread
  )
  await fixture.journal.appendItem(item(400), body('after the turn'), thread)
  const database = openTestJournalHostDatabase(fixture.root)
  database.transaction((db) => convertJournalSqlProjection(db, 'session-1'))
  const pool = new JournalSqlReaderPool(
    join(fixture.root, 'agent-session-journal.db'),
    journalSqlReaderPath()
  )
  try {
    const sql = journalSqlReads(pool, 'session-1')
    const memory = fixture.journal.reads
    const visited = async (reads: Pick<AgentSessionJournalReads, 'visitItems'>) => {
      const ids: [string, number][] = []
      await reads.visitItems({ kinds: ['turn', 'message'] }, (itemId, sequence) => {
        ids.push([itemId, sequence])
      })
      return ids
    }
    const answers = (reads: typeof sql) =>
      Promise.all([
        reads.cursor(),
        reads.physicalCursor(),
        reads.lastActivityAt(),
        reads.historyOrigin(),
        reads.contextFloor(),
        reads.item('orca:turn-1'),
        reads.itemBody(agentJournalItemKey(item(7))),
        reads.itemFence('orca:turn-1'),
        reads.canonicalItemId('orca:turn-1'),
        reads.hasRecordedItem('orca:missing'),
        reads.runningTurn(),
        reads.threadGoalSource(),
        reads.contextUsage(),
        visited(reads),
        reads.input({ kind: 'batch', reads: [{ kind: 'input-count' }, { kind: 'newest-turn' }] }),
        reads.pendingSubmissions(),
        reads.newestTurn(),
        reads.usageLimitCut(),
        reads.orcaStopCut(),
        reads.statusState(1),
        reads.statusIndicators({ start: 0, floor: 0 })
      ])
    const expected = await answers(memory)
    // Spans more than one reader page.
    expect(expected[13].length).toBeGreaterThan(256)
    expect(await answers(sql)).toEqual(expected)
  } finally {
    await pool.close()
  }
})
