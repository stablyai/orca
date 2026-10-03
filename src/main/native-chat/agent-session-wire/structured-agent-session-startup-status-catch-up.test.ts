// The catch-up's tasks and its quit: a launch where every listed chat has its row does no work at
// all, a launch that derives rows yields only when a task has run long enough, quit stops it with
// nothing more written, for the next launch to redo, and lease recovery starts before it.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as TimersPromises from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { agentSessionRecordFixture } from '../../../shared/agent-session-record.test-fixture'
import {
  closeTestJournalHostDatabases,
  createTrackedJournalOpener,
  openTestJournalHostDatabase,
  readTestJournalSessionStatus
} from '../agent-session-journal/journal-host-database-test-support'
import type * as StatusBackfillModule from '../agent-session-journal/journal-session-status-backfill'
import {
  CORPUS_FENCE,
  JOURNAL_SESSION_STATE_CORPUS
} from '../agent-session-journal/journal-session-state-test-corpus'
import type { StructuredAgentSessionStartupStateDeps } from './structured-agent-session-startup-state'

// What the catch-up did, in order: each yield to the event loop, and each fold it finished.
const trace = vi.hoisted(() => {
  const log: { events: string[]; afterFold: ((sessionId: string) => void) | null } = {
    events: [],
    afterFold: null
  }
  return log
})

vi.mock('node:timers/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof TimersPromises>()
  return {
    ...actual,
    setImmediate: (...args: Parameters<typeof actual.setImmediate>) => {
      trace.events.push('yield')
      return actual.setImmediate(...args)
    }
  }
})

vi.mock('../agent-session-journal/journal-session-status-backfill', async (importOriginal) => {
  const actual = await importOriginal<typeof StatusBackfillModule>()
  return {
    ...actual,
    foldJournalSessionStatus: async (
      ...args: Parameters<typeof actual.foldJournalSessionStatus>
    ) => {
      const folded = await actual.foldJournalSessionStatus(...args)
      trace.events.push(`fold:${args[1]}`)
      trace.afterFold?.(args[1])
      return folded
    }
  }
})

import { catchUpMissingStatuses } from './structured-agent-session-startup-status-catch-up'
import { createStructuredAgentSessionStartupState } from './structured-agent-session-startup-state'

const journals = createTrackedJournalOpener()
let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-startup-status-catch-up-'))
  trace.events = []
  trace.afterFold = null
})

afterEach(async () => {
  vi.restoreAllMocks()
  await journals.closeAll()
  closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

/** Chats with a settled history in the host's database; `rowless` drops their status rows. */
async function chats(sessionIds: readonly string[], { rowless }: { rowless: boolean }) {
  for (const sessionId of sessionIds) {
    const journal = await journals.open({
      identity: {
        sessionId,
        workspaceId: 'ws-1',
        hostId: 'local',
        agent: 'codex',
        providerHandle: { kind: 'codex', threadId: `thread-${sessionId}` }
      },
      stateDirectory: root,
      mintEpoch: () => `epoch-${sessionId}`,
      currentFence: () => CORPUS_FENCE
    })
    await JOURNAL_SESSION_STATE_CORPUS.settled(journal)
  }
  await journals.closeAll()
  if (rowless) {
    openTestJournalHostDatabase(root).db.exec('DELETE FROM journal_session_state')
  }
}

function deps(
  disposed: { value: boolean } = { value: false },
  recovering: {
    records: AgentSessionRecord[]
    resolveRecovery: (id: string) => Promise<boolean>
  } = {
    records: [],
    resolveRecovery: async () => true
  }
): StructuredAgentSessionStartupStateDeps {
  const stand = {
    openDeps: {
      journalDatabase: openTestJournalHostDatabase(root),
      store: {
        getRecord: (sessionId: string): AgentSessionRecord => ({
          ...agentSessionRecordFixture(),
          sessionId
        }),
        listRecords: () => recovering.records
      },
      logger: { warn: vi.fn(), error: vi.fn() }
    },
    canSettle: (candidate: AgentSessionRecord | null): candidate is AgentSessionRecord =>
      candidate !== null,
    seedStatus: vi.fn(),
    reconcile: async () => true,
    resolveRecovery: recovering.resolveRecovery,
    restoreListed: async () => undefined,
    serialize: <T>(_sessionId: string, task: () => Promise<T>) => task(),
    hasSession: () => false,
    isListed: () => true,
    isDisposed: () => disposed.value
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the catch-up reads only the database, records, logger and the members above.
  return stand as unknown as StructuredAgentSessionStartupStateDeps
}

const yields = () => trace.events.filter((event) => event === 'yield').length
const folds = () => trace.events.filter((event) => event.startsWith('fold:'))

describe('the startup status catch-up', () => {
  it('does nothing on a launch where every listed chat has its row', async () => {
    const ids = Array.from({ length: 40 }, (_, index) => `session-${index}`)
    await chats(ids, { rowless: false })
    const stand = deps()
    const transaction = vi.spyOn(stand.openDeps.journalDatabase, 'transaction')
    trace.events = []

    await catchUpMissingStatuses(stand, ids)

    // No fold, no yield, no transaction.
    expect(folds()).toEqual([])
    expect(yields()).toBe(0)
    expect(transaction).not.toHaveBeenCalled()
  })

  it('yields only once a task has run long enough, not before every chat', async () => {
    const ids = Array.from({ length: 30 }, (_, index) => `session-${index}`)
    await chats(ids, { rowless: true })
    // Each clock read moves 3 ms: a task reaches the 16 ms budget every few chats.
    let clock = 0
    vi.spyOn(performance, 'now').mockImplementation(() => (clock += 3))
    trace.events = []

    await catchUpMissingStatuses(deps(), ids)

    expect(folds()).toHaveLength(ids.length)
    expect(yields()).toBeGreaterThan(0)
    expect(yields()).toBeLessThan(ids.length / 2)
    expect(
      ids.every((sessionId) => readTestJournalSessionStatus(root, sessionId)?.lifecycle === 'idle')
    ).toBe(true)
  })

  it.each([
    ['mid-way', 10, 3],
    ['during the last fold', 10, 10],
    // The 16th fold fills a batch, which is due its write at once.
    ['during the fold that fills a batch', 20, 16]
  ])(
    'writes nothing after quit %s, and the next launch redoes it',
    async (_when, count, quitAtFold) => {
      const ids = Array.from({ length: count }, (_, index) => `session-${index}`)
      await chats(ids, { rowless: true })
      const disposed = { value: false }
      // Every task boundary is due a yield, but the quit lands before the next one.
      let clock = 0
      vi.spyOn(performance, 'now').mockImplementation(() => (clock += 100))
      trace.afterFold = () => {
        if (folds().length === quitAtFold) {
          disposed.value = true
        }
      }
      const stand = deps(disposed)
      const transaction = vi.spyOn(stand.openDeps.journalDatabase, 'transaction')

      await catchUpMissingStatuses(stand, ids)

      expect(folds()).toHaveLength(quitAtFold)
      expect(transaction).not.toHaveBeenCalled()
      expect(ids.some((sessionId) => readTestJournalSessionStatus(root, sessionId))).toBe(false)

      trace.afterFold = null
      disposed.value = false
      await catchUpMissingStatuses(deps(), ids)
      expect(ids.every((sessionId) => readTestJournalSessionStatus(root, sessionId))).toBe(true)
    }
  )

  it('runs after the lease check started every lease recovery, listed or not', async () => {
    const ids = ['session-0', 'session-1']
    await chats(ids, { rowless: true })
    const crashed = ['session-0', 'session-tabless'].map((sessionId) => {
      const record = { ...agentSessionRecordFixture(), sessionId }
      record.lease = { ...record.lease, sessionId, handoffStage: 'recovering' }
      return record
    })
    const state = createStructuredAgentSessionStartupState(
      deps(undefined, {
        records: crashed,
        resolveRecovery: async (sessionId) => {
          trace.events.push(`recover:${sessionId}`)
          return true
        }
      })
    )
    trace.events = []

    await state.reconcileRestartLeases()
    await state.catchUpMissingStatuses(ids)

    const firstFold = trace.events.findIndex((event) => event.startsWith('fold:'))
    expect(firstFold).toBeGreaterThan(-1)
    expect(trace.events.slice(0, firstFold)).toEqual(
      expect.arrayContaining(['recover:session-0', 'recover:session-tabless'])
    )
  })
})
