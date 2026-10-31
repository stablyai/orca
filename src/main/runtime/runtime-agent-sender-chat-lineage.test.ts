import { afterEach, expect, it, vi } from 'vitest'
import { createRuntimeAgentProjections } from './construction/runtime-agent-projections'
import {
  clearedInto,
  conversationRecordReader,
  type AgentSessionRecordReader
} from './orchestration/structured-session-lineage'
import { scaleDirectory, scaleRecord } from './agent-session-scale.test-fixture'
import {
  openTestAgentSessionRecordStore,
  seedTestAgentSessionRecordStore
} from './agent-session-record-store-test-harness'
import { readAgentSenderSessions } from './runtime-agent-sender-history'
import type { AgentSessionRecord } from '../../shared/agent-session-record'

afterEach(() => vi.restoreAllMocks())

/** A committed /clear: the durable forward pointer the reverse index is derived from. */
const cleared = (record: AgentSessionRecord, next: string): AgentSessionRecord => ({
  ...record,
  conversationCommand: {
    command: 'clear',
    runtimeFence: 8,
    operationId: `op-clear-${record.sessionId}`,
    callerKey: 'renderer',
    phase: 'committed',
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
      issueLeafHandle: () => '',
      issuePtyHandle: () => '',
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
      expect(h.rows()).toEqual(expected)
      // Open chats plus their predecessors, whatever the saved history holds.
      expect(visits() - before).toBeLessThanOrEqual(readsAtMost)
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
    // A reload derives the index again from the saved pointers: the same as the kept one.
    const reopened = await openTestAgentSessionRecordStore(h.root)
    const index = (store: typeof h.store) =>
      store.listHeldSessionIds().map((id) => [id, [...store.listClearedFrom(id)].sort()])
    expect(index(reopened)).toEqual(index(h.store))
  }
)
