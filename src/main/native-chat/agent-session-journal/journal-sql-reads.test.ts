import type { JournalWorkAuthority } from './journal-observer-read'
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
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
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
  await fixture.journal.appendItem(
    { provider: 'orca', clientMessageId: 'options-message' },
    body('message with controls'),
    thread
  )
  const database = openTestJournalHostDatabase(fixture.root)
  database.transaction((db) => convertJournalSqlProjection(db, 'session-1'))
  const pool = new JournalSqlReaderPool(
    join(fixture.root, 'agent-session-journal.db'),
    journalSqlReaderPath()
  )
  try {
    const sql = journalSqlReads(pool, 'session-1')
    const memory = fixture.journal.reads
    expect(await sql.hasItems()).toBe(true)
    expect(await sql.namedTurn('turn-1')).toEqual({
      scope: { kind: 'turn', turnItemId: 'orca:turn-1' },
      removed: false
    })
    expect(await sql.namedTurn('missing-turn')).toEqual({ scope: null, removed: false })
    expect(await sql.messageOptions('options-message')).toEqual({
      ordinaryMessage: true,
      runningTurn: true
    })
    expect(await sql.messageOptions('turn-1')).toEqual({
      ordinaryMessage: false,
      runningTurn: true
    })
    expect(await sql.canonicalItemIds(['orca:turn-1', 'orca:missing'])).toEqual([
      { itemId: 'orca:turn-1', canonicalItemId: 'orca:turn-1' },
      { itemId: 'orca:missing', canonicalItemId: 'orca:missing' }
    ])
    const turns: AgentJournalRenderItem[] = []
    await sql.visitItems({ kinds: ['turn'] }, (_id, _sequence, _body, _linkage, item) => {
      turns.push(item)
    })
    expect(turns).toMatchObject([
      {
        itemId: 'orca:turn-1',
        revision: 1,
        sequence: 302,
        body: { kind: 'turn', turnId: 'turn-1', state: 'running' }
      }
    ])
    const memoryTurns: AgentJournalRenderItem[] = []
    await memory.visitItems({ kinds: ['turn'] }, (_id, _sequence, _body, _linkage, item) => {
      memoryTurns.push(item)
    })
    expect(memoryTurns).toEqual(turns)
    const visited = async (reads: Pick<AgentSessionJournalReads, 'visitItems'>) => {
      const ids: [string, number][] = []
      await reads.visitItems({ kinds: ['turn', 'message'] }, (itemId, sequence) => {
        ids.push([itemId, sequence])
      })
      return ids
    }
    const answers = (reads: AgentSessionJournalReads) =>
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
        reads.messageOptions('options-message'),
        reads.usageLimitCut(),
        reads.orcaStopCut(),
        reads.statusState(1),
        reads.statusIndicators({ start: 0, floor: 0 })
      ])
    const expected = await answers(memory)
    // Spans more than one reader page.
    expect(expected[13].length).toBeGreaterThan(256)
    expect(await answers(sql)).toEqual(expected)
    const authority: JournalWorkAuthority = {
      handle: 'this-open',
      record: {
        currentFence: 1,
        ownerObservation: { claimStatus: 'live', unreconciled: false, handoffStage: null }
      },
      child: { fence: 1, heldSends: [] },
      handingOver: [],
      continuingUnadmitted: [],
      finalizing: [],
      openedThrough: await sql.physicalCursor(),
      reopenFloor: null,
      operationalRevision: 0,
      stopRevision: 0,
      stop: null
    }
    const observed = await sql.observer({
      authority,
      start: 0,
      floor: 0,
      firstInputSubmissionKey: null
    })
    expect(observed.work).toMatchObject({
      liveFence: 1,
      working: true,
      activeTurn: { turnId: 'turn-1' }
    })
    expect(observed.state).toEqual(expected[19])
    const ended = await sql.observer({
      authority: {
        ...authority,
        ended: { fence: 1, rootGone: true, cause: 'exit' },
        operationalRevision: 1
      },
      start: 0,
      floor: 0,
      firstInputSubmissionKey: null
    })
    expect(ended.physicalCursor).toEqual(observed.physicalCursor)
    expect(ended.work).toMatchObject({
      liveFence: null,
      working: false,
      activeTurn: null,
      latestTurn: { itemId: 'orca:turn-1', turn: { state: 'interrupted' } }
    })
    expect(ended.state.summary).toMatchObject({ status: 'idle', turnOutcome: 'interruption' })
    expect(structuredClone(ended)).toEqual(ended)
  } finally {
    await pool.close()
  }
})
