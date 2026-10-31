import { afterEach, expect, it, vi } from 'vitest'
import { createRuntimeAgentProjections } from './construction/runtime-agent-projections'
import {
  clearedInto,
  conversationRecordReader,
  type AgentSessionRecordReader
} from './orchestration/structured-session-lineage'
import { scaleDirectory, scaleRecord } from './agent-session-scale.test-fixture'
import {
  editPersistedTestAgentSessionStore,
  openTestAgentSessionRecordStore,
  seedTestAgentSessionRecordStore
} from './agent-session-record-store-test-harness'
import { readAgentSenderSessions } from './runtime-agent-sender-history'
import {
  AGENT_SESSION_PREDECESSOR_IDS,
  agentSessionPredecessorWorkForTest
} from './agent-session-record-lineage'
import { openTestJournalHostDatabase } from '../native-chat/agent-session-journal/journal-host-database-test-support'
import type { AgentSessionRecord } from '../../shared/agent-session-record'

const unissued = (): never => {
  throw new Error('a sender build issued a terminal handle')
}

afterEach(() => vi.restoreAllMocks())

/** A committed /clear: the durable forward pointer the reverse index is derived from. */
const cleared = (
  record: AgentSessionRecord,
  next: string,
  phase: 'committed' | 'prepared' = 'committed'
): AgentSessionRecord => ({
  ...record,
  conversationCommand: {
    command: 'clear',
    runtimeFence: 8,
    operationId: `op-clear-${record.sessionId}`,
    callerKey: 'renderer',
    phase,
    state: 'completed',
    replacementSessionId: next
  }
})

/** Six open chats, one behind a three-deep /clear chain, and `history` unrelated closed chats. */
async function chats(history: number) {
  const root = await scaleDirectory()
  const open = ['opened-0', 'opened-1', 'opened-2', 'opened-3', 'opened-4', 'cleared-3'].map((id) =>
    scaleRecord(id)
  )
  const chain = ['cleared-0', 'cleared-1', 'cleared-2'].map((id, i) =>
    cleared(scaleRecord(id), `cleared-${i + 1}`)
  )
  const closed = Array.from({ length: history }, (_, i) => scaleRecord(`closed-chat-${i}`))
  await seedTestAgentSessionRecordStore(root, {
    records: [...open, ...chain, ...closed, scaleRecord('opened-5')],
    sessionTabs: open.map((row) => ({ tabId: `tab-${row.sessionId}`, sessionId: row.sessionId }))
  })
  const store = await openTestAgentSessionRecordStore(root)
  const inventories = vi.spyOn(store, 'listConversations')
  const records = conversationRecordReader(store)
  const { senders } = createRuntimeAgentProjections(
    {
      getExistingOrchestrationDb: () => null,
      resolveOrchestrationWorkerServer: () => {
        throw new Error('unpaired')
      }
    },
    {
      getDb: () => null,
      getLeaves: () => [],
      getPtys: () => [],
      paneOf: () => ({ tabId: null, paneKey: null, recordedAtGraphSequence: 0 }),
      // Orchestration issues handles; sender rows only read the ones already issued.
      issueLeafHandle: unissued,
      issuePtyHandle: unissued,
      readLeafHandle: () => null,
      readPtyHandles: () => () => null,
      makePaneKey: () => '',
      getWorktreeId: () => null,
      getHandleForPaneKey: () => null,
      getPaneKey: () => null,
      getDispatchAuthority: () => null,
      getAgentStatusSnapshot: () => [],
      getSessionRecords: () => records
    }
  )
  /** The chat rows a build publishes, as identity -> the session it now opens. */
  const rows = () =>
    Object.fromEntries(
      senders
        .build()
        .associations.filter((row) => row.sessionId)
        .map((row) => [row.identity.slice('orca_session_id:'.length), row.sessionId])
    )
  /** What every saved chat says, read the slow way: the full scan the index replaces. */
  const oracle = () => {
    inventories.mockClear()
    const { listClearedFrom: _index, ...listing }: AgentSessionRecordReader = records
    const scanned = Object.fromEntries(
      readAgentSenderSessions(listing).map((row) => [
        row.identity.slice('orca_session_id:'.length),
        row.sessionId
      ])
    )
    const rebuilt = new Map<string, string[]>()
    for (const record of store.listConversations()) {
      const next = clearedInto(record)
      if (next) {
        rebuilt.set(next, [...(rebuilt.get(next) ?? []), record.sessionId].sort())
      }
    }
    const indexed = new Map(
      store.listHeldSessionIds().flatMap((id) => {
        const from = [...store.listClearedFrom(id)].sort()
        return from.length ? [[id, from] as const] : []
      })
    )
    inventories.mockClear()
    return { scanned, index: Object.fromEntries(indexed), rebuilt: Object.fromEntries(rebuilt) }
  }
  return { root, store, senders, rows, oracle, inventories }
}

it.each([1_000, 10_000])(
  'reads only open chats and their /clear predecessors, at %i unrelated saved chats',
  async (history) => {
    const h = await chats(history)
    const visits = () => h.senders.workForTest().chatRecords
    const check = (expected: Record<string, string>, readsAtMost: number) => {
      const before = visits()
      const seeks = agentSessionPredecessorWorkForTest()
      expect(h.rows()).toEqual(expected)
      // Open chats plus their predecessors, whatever the saved history holds: one indexed seek
      // per visited chat, returning only rows that name it.
      expect(visits() - before).toBeLessThanOrEqual(readsAtMost)
      const work = agentSessionPredecessorWorkForTest()
      expect(work.seeks - seeks.seeks).toBeLessThanOrEqual(readsAtMost)
      expect(work.rows - seeks.rows).toBeLessThanOrEqual(readsAtMost)
      expect(h.inventories).not.toHaveBeenCalled()
      const { scanned, index, rebuilt } = h.oracle()
      expect(scanned).toEqual(expected)
      expect(index).toEqual(rebuilt)
    }
    const base = {
      'opened-0': 'opened-0',
      'opened-1': 'opened-1',
      'opened-2': 'opened-2',
      'opened-3': 'opened-3',
      'opened-4': 'opened-4',
      'cleared-0': 'cleared-3',
      'cleared-1': 'cleared-3',
      'cleared-2': 'cleared-3',
      'cleared-3': 'cleared-3'
    }
    check(base, 9)
    await h.store.setSessionTabVisibility('opened-5', true)
    check({ ...base, 'opened-5': 'opened-5' }, 10)
    await h.store.setSessionTabVisibility('opened-5', false)
    check(base, 9)
    // A committed /clear continues opened-1 in opened-2: its cards follow, through the index.
    await h.store.reviseSessionOptions((record) => cleared(record, 'opened-2'), {
      sessionId: 'opened-1'
    })
    const { 'opened-1': _cleared, ...rest } = base
    check({ ...rest, 'opened-1': 'opened-2' }, 9)
    // A move keeps the identity and changes only where the row says the chat runs.
    await h.store.reviseSessionOptions(
      (record) => ({ ...record, location: { ...record.location, workspaceId: 'moved' } }),
      { sessionId: 'cleared-3' }
    )
    expect(h.senders.build().associations.find((row) => row.sessionId === 'cleared-3')).toEqual(
      expect.objectContaining({ worktreeId: 'moved' })
    )
    // A reload reads the same saved pointers.
    const reopened = await openTestAgentSessionRecordStore(h.root)
    const index = (store: typeof h.store) =>
      store.listHeldSessionIds().map((id) => [id, [...store.listClearedFrom(id)].sort()])
    expect(index(reopened)).toEqual(index(h.store))
  }
)

it('follows branching, unreadable and cyclic /clear predecessors as the full scan does, by index', async () => {
  const root = await scaleDirectory()
  await seedTestAgentSessionRecordStore(root, {
    records: [
      cleared(scaleRecord('session-a'), 'session-c'),
      cleared(scaleRecord('session-b'), 'session-c'),
      cleared(scaleRecord('unreadable-u'), 'session-c'),
      cleared(scaleRecord('prepared-to-c'), 'session-c', 'prepared'),
      scaleRecord('session-c'),
      cleared(scaleRecord('cycle-x1'), 'cycle-y1'),
      cleared(scaleRecord('cycle-y1'), 'cycle-x1')
    ],
    sessionTabs: ['session-c', 'cycle-x1'].map((id) => ({ tabId: `tab-${id}`, sessionId: id }))
  })
  // A lease this build can't decode leaves the chat readable as a conversation.
  await editPersistedTestAgentSessionStore(root, (state) => {
    Object.assign(state.records['unreadable-u'].lease, { minimumNextFence: 'bad' })
  })
  const store = await openTestAgentSessionRecordStore(root)
  expect(store.isSessionUnreadable('unreadable-u')).toBe(true)
  const records = conversationRecordReader(store)
  const { listClearedFrom: _index, ...listing }: AgentSessionRecordReader = records
  const rows = (reader: AgentSessionRecordReader) =>
    readAgentSenderSessions(reader)
      .map((row) => `${row.identity.slice('orca_session_id:'.length)}>${row.sessionId}`)
      .sort()
  expect(rows(records)).toEqual(rows(listing))
  expect(rows(records)).toEqual([
    'cycle-x1>cycle-x1',
    'session-a>session-c',
    'session-b>session-c',
    'session-c>session-c',
    'unreadable-u>session-c'
  ])
  const plan = openTestJournalHostDatabase(root)
    .db.prepare(`EXPLAIN QUERY PLAN ${AGENT_SESSION_PREDECESSOR_IDS}`)
    .all('session-c')
    .map((row) => String(row.detail))
  expect(plan.join('\n')).toContain('USING INDEX idx_agent_session_clear_successor')
})
