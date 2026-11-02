import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as StoreDraft from './agent-session-store-draft'
import type * as StoreRows from './agent-session-record-rows'
import {
  agentSessionStoreDraftRowWrites,
  draftAgentSessionStoreState
} from './agent-session-store-draft'
import { writeAgentSessionStoreRows } from './agent-session-record-rows'
import { openTestAgentSessionRecordStore } from './agent-session-record-store-test-harness'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from '../../../native-chat/agent-session-journal/journal-host-database-test-support'

// Pass-through spies: they count full-store drafts, diffs and SQL row writes without changing them.
vi.mock('./agent-session-store-draft', async (importOriginal) => {
  const actual = await importOriginal<typeof StoreDraft>()
  return {
    ...actual,
    draftAgentSessionStoreState: vi.fn(actual.draftAgentSessionStoreState),
    agentSessionStoreDraftRowWrites: vi.fn(actual.agentSessionStoreDraftRowWrites)
  }
})
vi.mock('./agent-session-record-rows', async (importOriginal) => {
  const actual = await importOriginal<typeof StoreRows>()
  return { ...actual, writeAgentSessionStoreRows: vi.fn(actual.writeAgentSessionStoreRows) }
})

const NOW = 1_800_000_000_000
let counter = 0
let directory: string

function operationId(): string {
  counter += 1
  return `${NOW}-${String(counter).padStart(32, '0')}`
}

function open() {
  return openTestAgentSessionRecordStore(directory, { hostId: 'local' })
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-agent-session-store-retirement-'))
})

afterEach(async () => {
  await closeTestJournalHostDatabases()
  await rm(directory, { recursive: true, force: true })
})

describe('prepared launch retirement waves', () => {
  /** Full-store work since the last reset: drafts and the operation rows each copied or diffed. */
  function storeWork() {
    const drafts = vi.mocked(draftAgentSessionStoreState).mock.calls
    const diffs = vi.mocked(agentSessionStoreDraftRowWrites).mock.calls
    const sql = vi.mocked(writeAgentSessionStoreRows).mock.calls
    return {
      drafts: drafts.length,
      copiedRows: drafts.reduce((rows, [state]) => rows + state.operations.size, 0),
      diffedRows: diffs.reduce((rows, [published]) => rows + published.operations.size, 0),
      sqlTransactions: sql.length,
      upserts: sql.reduce((rows, [, writes]) => rows + writes.operations.upsert.length, 0)
    }
  }

  function resetStoreWork() {
    vi.mocked(draftAgentSessionStoreState).mockClear()
    vi.mocked(agentSessionStoreDraftRowWrites).mockClear()
    vi.mocked(writeAgentSessionStoreRows).mockClear()
  }

  async function storeWithLaunches(launches: number, unrelated: number) {
    const store = await open()
    for (let index = 0; index < unrelated; index++) {
      await store.admitOperation({
        callerKey: 'other-caller',
        operationId: operationId(),
        fingerprint: 'fingerprint',
        now: NOW
      })
    }
    const ready = []
    for (let index = 0; index < launches; index++) {
      const id = operationId()
      await store.recordPreparedAgentLaunch({
        callerKey: 'worktree-startup',
        operationId: id,
        fingerprint: 'fingerprint',
        now: NOW,
        preparedLaunch: { daemonGeneration: 'daemon', reservationGeneration: `r-${index}` }
      })
      ready.push({
        callerKey: 'worktree-startup',
        operationId: id,
        daemonGeneration: 'daemon',
        reservationGeneration: `r-${index}`,
        outcome: {
          status: 'failed' as const,
          code: 'spawn-failed',
          message: 'Codex could not start.'
        }
      })
    }
    return { store, ready }
  }

  it.each([
    [10, 10],
    [10, 100],
    [100, 10],
    [100, 100]
  ])(
    'retires %i ready launches among %i unrelated rows in one draft, with one winner each',
    async (launches, unrelated) => {
      const { store, ready } = await storeWithLaunches(launches, unrelated)
      const rows = launches + unrelated
      resetStoreWork()
      // Two controllers observe the same ready wave.
      const answers = await Promise.all(
        [...ready, ...ready].map((request) => store.retirePreparedAgentLaunch(request))
      )
      expect(storeWork()).toEqual({
        drafts: 1,
        copiedRows: rows,
        diffedRows: rows,
        sqlTransactions: 1,
        upserts: launches
      })
      // Each launch has exactly one winning request, so it is explained exactly once.
      const winners = ready.map((_, index) => [answers[index], answers[launches + index]])
      expect(winners.every((pair) => pair.filter(Boolean).length === 1)).toBe(true)
      const saved = store.getOperationRow('worktree-startup', ready[0]!.operationId)
      expect(saved).not.toHaveProperty('preparedLaunch')
      expect(saved?.outcome).toEqual(ready[0]!.outcome)

      // A late wave of observers finds every descriptor consumed and costs no full-store work.
      resetStoreWork()
      const late = await Promise.all(
        ready.map((request) => store.retirePreparedAgentLaunch(request))
      )
      expect(late.every((removed) => !removed)).toBe(true)
      expect(storeWork()).toEqual({
        drafts: 0,
        copiedRows: 0,
        diffedRows: 0,
        sqlTransactions: 0,
        upserts: 0
      })
    }
  )

  it('keeps every descriptor retirable when the wave fails to commit', async () => {
    const { store, ready } = await storeWithLaunches(3, 2)
    const db = openTestJournalHostDatabase(directory).db
    db.exec(
      "CREATE TRIGGER fail_operation_write BEFORE UPDATE ON agent_session_operations BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END"
    )
    await expect(
      Promise.all(ready.map((request) => store.retirePreparedAgentLaunch(request)))
    ).rejects.toThrow('disk I/O error')
    expect(store.getOperationRow('worktree-startup', ready[0]!.operationId)).toHaveProperty(
      'preparedLaunch'
    )
    db.exec('DROP TRIGGER fail_operation_write')
    await expect(
      Promise.all(ready.map((request) => store.retirePreparedAgentLaunch(request)))
    ).resolves.toEqual([true, true, true])
  })
})
