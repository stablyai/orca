// A failed append's undo, as a property: every append first runs with a failing COMMIT, then for
// real, and after each the in-memory fold equals a fresh replay of the disk, container by container
// with key order, scalars and turn scope, and the stored status equals a fresh derivation.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalItemIdentity,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import {
  createTrackedJournalOpener,
  loadTestJournal,
  openTestJournalHostDatabase,
  readTestJournalSessionStatus
} from './journal-host-database-test-support'
import type { JournalFoldHolder } from './journal-fold-holder'
import { JournalQueuedMessages } from './journal-queued-messages'
import { MAX_JOURNAL_APPLIED_SETTLEMENT_IDS, type JournalReducerState } from './journal-reducer'
import { deriveJournalSessionStatus } from './journal-session-state'
import {
  CORPUS_FENCE,
  JOURNAL_SESSION_STATE_CASES,
  JOURNAL_SESSION_STATE_CORPUS
} from './journal-session-state-test-corpus'
import type { AgentSessionJournal } from './journal-store'

const journals = createTrackedJournalOpener()
let root: string
let clock = 1_000

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-fold-undo-'))
  clock = 1_000
})

afterEach(async () => {
  vi.restoreAllMocks()
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

function identity(sessionId: string): AgentSessionJournalIdentity {
  return {
    sessionId,
    workspaceId: 'ws-1',
    hostId: 'local',
    agent: 'codex',
    providerHandle: { kind: 'codex', threadId: `thread-${sessionId}` }
  }
}

function open(sessionId: string): Promise<AgentSessionJournal> {
  return journals.open({
    identity: identity(sessionId),
    stateDirectory: root,
    now: () => (clock += 1),
    mintEpoch: () => `epoch-${sessionId}-${clock}`,
    currentFence: () => CORPUS_FENCE
  })
}

function failNextCommit(): () => void {
  const connection = openTestJournalHostDatabase(root).db
  const exec = connection.exec.bind(connection)
  let failing = true
  const spy = vi.spyOn(connection, 'exec').mockImplementation((sql: string) => {
    if (failing && sql === 'COMMIT') {
      failing = false
      throw new Error('COMMIT failed: disk I/O error')
    }
    return exec(sql)
  })
  return () => spy.mockRestore()
}

type JournalInternals = {
  fold: JournalFoldHolder
  rowWriter: { enqueue: (build: unknown, hook?: unknown) => Promise<unknown> }
}

function internals(journal: AgentSessionJournal): JournalInternals {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the store's private fold and row writer, read to compare against a replay; both fields exist on every store.
  return journal as unknown as JournalInternals
}

/** Every scalar, every container in key order, and the turn scope's open turn. */
function comparableFold(state: JournalReducerState) {
  const { derivedTurnScope, ...rest } = state
  return {
    ...Object.fromEntries(
      Object.entries(rest).map(([key, value]) => [
        key,
        value instanceof Map || value instanceof Set ? [...value.entries()] : value
      ])
    ),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the scope's private open turn, the one field a clone carries.
    openTurn: (derivedTurnScope as unknown as { openTurnItemId: string | null }).openTurnItemId
  }
}

/** The fold as the store serves it: a stale fold is re-read first. */
function servedFold(journal: AgentSessionJournal): JournalReducerState {
  return internals(journal).fold.get()
}

function expectFoldIsTheDisk(journal: AgentSessionJournal, sessionId: string): void {
  const loaded = loadTestJournal(root, sessionId)!
  expect(comparableFold(servedFold(journal))).toEqual(comparableFold(loaded.state))
  expect(readTestJournalSessionStatus(root, sessionId)).toEqual(
    deriveJournalSessionStatus(loaded.state, {
      settlesRosters: !loaded.corrupt,
      currentFence: CORPUS_FENCE
    })
  )
}

/** Every append is first tried with a failing COMMIT, then for real, one append at a time.
 *  Answers every check that failed, so a case that swallows an append's error still reports it. */
function failEveryAppendOnce(journal: AgentSessionJournal, sessionId: string): unknown[] {
  const violations: unknown[] = []
  const check = (run: () => void) => {
    try {
      run()
    } catch (error) {
      violations.push(error)
      throw error
    }
  }
  const writer = internals(journal).rowWriter
  const enqueue = writer.enqueue.bind(writer)
  let tail: Promise<unknown> = Promise.resolve()
  const twice = async (build: unknown, hook?: unknown) => {
    const statusBefore = readTestJournalSessionStatus(root, sessionId)
    const restore = failNextCommit()
    const failed = await enqueue(build, hook).then(
      () => new Error('the failing COMMIT committed'),
      (error: unknown) => error
    )
    restore()
    check(() => {
      expect(readTestJournalSessionStatus(root, sessionId)).toEqual(statusBefore)
      expectFoldIsTheDisk(journal, sessionId)
    })
    if (!String(failed).includes('COMMIT failed')) {
      // Refused before its COMMIT (a revision rule, a held id): nothing to retry.
      throw failed
    }
    const committed = await enqueue(build, hook)
    check(() => expectFoldIsTheDisk(journal, sessionId))
    return committed
  }
  writer.enqueue = (build, hook) => {
    const run = tail.then(() => twice(build, hook))
    tail = run.catch(() => undefined)
    return run
  }
  return violations
}

function assistant(text: string) {
  return {
    kind: 'message' as const,
    role: 'assistant' as const,
    blocks: [{ type: 'text' as const, text }]
  }
}

function codexItem(turnId: string, ordinal: number): AgentJournalItemIdentity {
  return { provider: 'codex', threadId: 'thread-corpus', turnId, ordinal }
}

const THREAD = { fence: CORPUS_FENCE, turnScope: { kind: 'thread' as const } }

describe('a failed append leaves the fold equal to a replay of the disk', () => {
  it.each(JOURNAL_SESSION_STATE_CASES)('%s', async (name) => {
    const journal = await open(name)
    const violations = failEveryAppendOnce(journal, name)
    await JOURNAL_SESSION_STATE_CORPUS[name](journal)
    expect(violations).toEqual([])
  })

  it('through every case on one chat, a tombstone and a recreate', async () => {
    const journal = await open('mixed')
    const violations = failEveryAppendOnce(journal, 'mixed')
    for (const name of JOURNAL_SESSION_STATE_CASES) {
      // Cases reuse ids; a revision rule refusing a stale one is a write path too.
      await JOURNAL_SESSION_STATE_CORPUS[name](journal).catch(() => undefined)
    }
    const id = codexItem('t-x', 0)
    await journal.appendItem(id, assistant('a'), THREAD)
    await journal.appendTombstone(id, { fence: CORPUS_FENCE })
    await journal.appendItem(id, assistant('b'), THREAD)
    expect(violations).toEqual([])
  })

  it('keeps map order when the failed append tombstoned an item that is not the newest', async () => {
    const journal = await open('order')
    for (const ordinal of [0, 1]) {
      await journal.appendItem(codexItem('t-1', ordinal), assistant('x'), THREAD)
    }
    const violations = failEveryAppendOnce(journal, 'order')

    await journal.appendTombstone(codexItem('t-1', 0), { fence: CORPUS_FENCE })
    expect(violations).toEqual([])
  })

  it("keeps a person's Stop and the queue's Resume as a replay reads them", async () => {
    const journal = await open('stop')
    await journal.appendItem(codexItem('t-1', 0), assistant('x'), THREAD)
    const violations = failEveryAppendOnce(journal, 'stop')

    await journal.appendStopEvent({ reason: 'user-stop', turnId: 't-1' }, CORPUS_FENCE)
    await journal.appendQueueResume(CORPUS_FENCE)
    await journal.appendStopEvent({ reason: 'user-stop' }, CORPUS_FENCE)
    expect(violations).toEqual([])
  })

  it.each(JOURNAL_SESSION_STATE_CASES)(
    'with a bookkeeping savepoint that always fails: %s',
    async (name) => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      vi.spyOn(JournalQueuedMessages.prototype, 'onRowInTransaction').mockImplementation((db) => {
        db.prepare(
          `INSERT INTO journal_session_state (session_id, lifecycle, active_turn_id, handed_over_sends,
           queued_sends, live_child_work, summary_json, last_activity_at, rules_version)
         VALUES ('savepoint-write', 'running', NULL, 0, 0, 0, '{}', 0, 1)`
        ).run()
        throw new Error('bookkeeping failed')
      })
      const journal = await open(name)
      const violations = failEveryAppendOnce(journal, name)
      await JOURNAL_SESSION_STATE_CORPUS[name](journal)
      expect(violations).toEqual([])

      const savepointWrite = openTestJournalHostDatabase(root)
        .db.prepare("SELECT 1 FROM journal_session_state WHERE session_id = 'savepoint-write'")
        .get()
      expect(savepointWrite).toBeUndefined()
    }
  )
})

describe('a failed append that evicted the oldest settlement id (R3W-1)', () => {
  it('forgets the same ids a replay forgets, so a re-sent evicted settle is skipped live too', async () => {
    const journal = await open('cap')
    const note = (id: string) => ({
      kind: 'item' as const,
      identity: { provider: 'orca' as const, clientMessageId: id },
      body: { kind: 'status' as const, text: id },
      turnScope: { kind: 'thread' as const }
    })
    for (let index = 0; index < MAX_JOURNAL_APPLIED_SETTLEMENT_IDS; index += 1) {
      await journal.appendLifecycleBatch({
        settlementId: `s-${index}`,
        fence: CORPUS_FENCE,
        mutations: [note(`n-${index}`)]
      })
    }
    const restore = failNextCommit()
    await expect(
      journal.appendLifecycleBatch({
        settlementId: 's-new',
        fence: CORPUS_FENCE,
        mutations: [note('n-new')]
      })
    ).rejects.toThrow('COMMIT failed')
    restore()
    expectFoldIsTheDisk(journal, 'cap')

    // One more commit evicts the oldest, as a replay does; then a settle re-sent under that id.
    await journal.appendLifecycleBatch({
      settlementId: 's-after',
      fence: CORPUS_FENCE,
      mutations: [note('n-after')]
    })
    await journal.appendLifecycleBatch({
      settlementId: 's-1',
      fence: CORPUS_FENCE,
      mutations: [
        {
          kind: 'item',
          identity: codexItem('turn-1', 7),
          body: { kind: 'tool-call', name: 'shell', input: { command: 'x' }, state: 'running' },
          turnScope: { kind: 'thread' }
        }
      ]
    })

    expectFoldIsTheDisk(journal, 'cap')
  }, 120_000)
})
