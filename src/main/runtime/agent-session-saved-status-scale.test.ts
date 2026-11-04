import { expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../shared/agent-session-journal-types'
import { agentSessionOperationKey } from '../../shared/agent-session-operation-ledger'
import { scaleStore, scaleJournal } from './agent-session-scale.test-fixture'
import {
  editPersistedTestAgentSessionStore,
  openTestAgentSessionRecordStore
} from './agent-session-record-store-test-harness'
import { openTestJournalHostDatabase } from '../native-chat/agent-session-journal/journal-host-database-test-support'
import { StructuredAgentSessionStatusFeed } from '../native-chat/agent-session-wire/structured-agent-session-status-feed'
import { StructuredAgentSessionSavedStatus } from '../native-chat/agent-session-wire/structured-agent-session-saved-status'
import { indexedStatusFeedSession } from '../native-chat/agent-session-wire/structured-agent-session-status-feed-test-session'
import { createStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import { countStatusWriteWork } from './agent-session-status-write-work.test-support'

it.each([10, 100])(
  'bounds one real published turn edge with %i saved chats and operations',
  async (n) => {
    const rig = await scaleStore(n)
    await editPersistedTestAgentSessionStore(rig.root, (state) => {
      for (let i = 0; i < n; i++) {
        const row = {
          callerKey: 'retained-client',
          operationId: `1800000000000-${String(i).padStart(32, '0')}`,
          fingerprint: `fp-${i}`,
          operationTimestamp: 1_800_000_000_000,
          recordedAt: 1_800_000_000_000,
          expiresAt: 1_900_000_000_000,
          outcome: { status: 'unknown' as const }
        }
        state.operations[agentSessionOperationKey(row.callerKey, row.operationId)] = row
        state.retiredClaimKeys.push({ keyId: `retired-${i}`, retiredAt: 1_800_000_000_000 })
      }
    })
    const store = await openTestAgentSessionRecordStore(rig.root)
    const id = rig.rows[0]!.sessionId
    const journal = await scaleJournal(rig.root, id)
    const logger = createStructuredAgentSessionLogger()
    const writer = new StructuredAgentSessionSavedStatus(() => ({ store, logger }))
    const feed = new StructuredAgentSessionStatusFeed({
      sessions: new Map([
        [
          id,
          indexedStatusFeedSession({
            journal,
            provider: 'claude',
            child: { phase: 'ready', fence: 7, generation: 'child' }
          })
        ]
      ]),
      getConversation: store.getConversation,
      logger,
      now: () => 1_800_000_000_000,
      onPublished: writer.observe
    })
    const death = vi.fn()
    const unsubscribe = store.onDeathEvidence(death)
    const work = countStatusWriteWork()
    const db = openTestJournalHostDatabase(rig.root).db
    const prepare = db.prepare.bind(db)
    const sql = { records: 0, other: 0 }
    const observed = new WeakSet<object>()
    vi.spyOn(db, 'prepare').mockImplementation((query) => {
      const statement = prepare(query)
      if (/^(INSERT|DELETE|UPDATE)/.test(query) && !observed.has(statement)) {
        observed.add(statement)
        const run = statement.run.bind(statement)
        vi.spyOn(statement, 'run').mockImplementation((...args) => {
          sql[query.startsWith('INSERT INTO agent_session_records ') ? 'records' : 'other']++
          return run(...args)
        })
      }
      return statement
    })
    const turn = { provider: 'claude', sessionId: `provider-${id}-0`, uuid: 'turn' } as const
    await journal.appendItem(
      { ...turn, uuid: 'user' },
      { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] },
      { fence: 7, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    await journal.appendItem(
      turn,
      { kind: 'turn', turnId: 'turn', state: 'running', startedAt: 123 },
      { fence: 7, turnScope: { kind: 'turn', turnItemId: agentJournalItemKey(turn) } }
    )
    // Journal writes are outside the metadata publication measurement.
    sql.records = sql.other = 0
    feed.publish(id)
    await writer.drain()
    expect(store.getRecord(id)?.lastTurn).toMatchObject({ state: 'open', at: 123 })
    // Generic FIFO record transactions are O(R + O + T + K), with one changed SQLite row.
    const records = n + 1 // damaged and malformed rows are excluded from writable records
    const tabs = n + 2
    expect(work.counts).toEqual({
      drafts: 1,
      recordCopies: records,
      operationCopies: n,
      recordDiffs: records,
      operationDiffs: n,
      attribution: records,
      deathEvidence: 2 * records,
      tabCopies: tabs,
      tabComparisons: 2 * tabs,
      retiredCopies: n,
      retiredComparisons: n
    })
    expect(sql).toEqual({ records: 1, other: 0 })
    expect(death).not.toHaveBeenCalled()
    work.reset()
    sql.records = sql.other = 0
    for (let i = 1; i <= 10; i++) {
      await journal.appendItem(
        { ...turn, uuid: 'assistant' },
        {
          kind: 'message',
          role: 'assistant',
          state: 'running',
          blocks: [{ type: 'text', text: `stream ${i}` }]
        },
        { fence: 7, turnScope: { kind: 'turn', turnItemId: agentJournalItemKey(turn) } }
      )
      sql.records = sql.other = 0
      feed.publish(id)
      await writer.drain()
      expect(work.counts).toEqual(
        Object.fromEntries(Object.keys(work.counts).map((key) => [key, 0]))
      )
      expect(sql).toEqual({ records: 0, other: 0 })
    }
    unsubscribe()
  }
)
