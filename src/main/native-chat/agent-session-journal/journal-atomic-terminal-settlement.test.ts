import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalSnapshot
} from '../../../shared/agent-session-journal-types'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session-wire'
import { AgentSessionSubscribers } from '../agent-session-wire/structured-agent-session-subscribers'
import {
  settleStaleStructuredAgentSessionState,
  settleStructuredAgentSessionDeadGeneration
} from '../agent-session-wire/structured-agent-session-dead-generation-settlement'
import {
  createTrackedJournalOpener,
  openTestJournalHostDatabase,
  readTestJournalRows
} from './journal-host-database-test-support'
import type { JournalLifecycleMutationInput } from './journal-row-builders'
import { MAX_JOURNAL_LIFECYCLE_BATCH_BYTES, parseJournalRow } from './journal-row-schema'
import type { AgentSessionJournal } from './journal-store'

const SESSION = 'atomic-settlement'
const journals = createTrackedJournalOpener()
let root: string
let journal: AgentSessionJournal

async function open(sessionId = SESSION) {
  return journals.open({
    identity: {
      sessionId,
      workspaceId: 'folder-workspace',
      hostId: 'host',
      agent: 'codex',
      providerHandle: codexProviderHandle('thread')
    },
    stateDirectory: root,
    now: () => 1_000
  })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-atomic-settlement-'))
  journal = await open()
})

afterEach(async () => {
  vi.restoreAllMocks()
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

function rows() {
  return readTestJournalRows(openTestJournalHostDatabase(root).db, SESSION, journal.epoch).map(
    (stored) => {
      const parsed = parseJournalRow(stored.rowJson)
      if (!parsed.ok) {
        throw new Error('test row failed to parse')
      }
      return parsed.row
    }
  )
}

async function seedWork(count = 201) {
  await journal.appendSubmission({
    clientMessageId: 'send',
    payloadFingerprint: 'fingerprint',
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'continue' }] },
    fence: 7
  })
  const turn = await journal.appendItem(
    { provider: 'orca', clientMessageId: 'turn' },
    { kind: 'turn', turnId: 'turn', state: 'running', startedAt: 900 },
    { fence: 7, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  for (let index = 0; index < count; index++) {
    await journal.appendItem(
      { provider: 'orca', clientMessageId: `call-${index}` },
      {
        kind: 'tool-call',
        name: 'Write',
        input: { content: index === 0 ? '界😀'.repeat(220_000) : 'small' },
        state: 'running'
      },
      {
        fence: 7,
        turnScope: { kind: 'turn', turnItemId: turn.itemId },
        agentId: 'child',
        producerKind: 'agent'
      }
    )
  }
}

function settle() {
  return settleStructuredAgentSessionDeadGeneration({
    journal,
    sessionId: SESSION,
    fence: 7,
    settlementId: `exit:${SESSION}:7`,
    verdict: { state: 'interrupted', completedAt: 1_000 },
    pendingSubmissionReason: 'provider_exited_before_acknowledgement',
    showUnexpectedExitOutcome: true
  })
}

describe('atomic terminal settlement', () => {
  it.each(['item', 'lifecycle-batch'] as const)(
    'rolls back a later %s rejection, publishes nothing, then retries exactly once',
    async (kind) => {
      await seedWork()
      const database = openTestJournalHostDatabase(root)
      const before = journal.snapshot()
      const diskBefore = rows()
      const published: AgentJournalSnapshot[] = []
      const frames: AgentSessionSubscribeEvent[] = []
      const emittedStates: AgentJournalSnapshot[] = []
      const subscribers = new AgentSessionSubscribers()
      subscribers.open({
        id: 'reader',
        sessionId: SESSION,
        journal,
        fence: 7,
        cursor: before.cursor,
        emit: (event) => {
          frames.push(event)
          emittedStates.push(journal.snapshot())
        }
      })
      frames.length = 0
      emittedStates.length = 0
      journal.observeCommits(() => {
        published.push(journal.snapshot())
        subscribers.publish(SESSION, journal)
      })
      const sawEarlierInserts: number[] = []
      const transaction = database.transaction.bind(database)
      vi.spyOn(database, 'transaction').mockImplementation((run) =>
        transaction((db) => {
          try {
            const result = run(db)
            expect(journal.snapshot()).toEqual(before)
            expect(published).toEqual([])
            expect(frames).toEqual([])
            return result
          } catch (error) {
            sawEarlierInserts.push(rows().length - diskBefore.length)
            expect(journal.snapshot()).toEqual(before)
            expect(published).toEqual([])
            expect(frames).toEqual([])
            throw error
          }
        })
      )
      database.db.exec(`CREATE TEMP TRIGGER reject_later_settlement BEFORE INSERT ON journal_rows
        WHEN NEW.session_id = '${SESSION}' AND json_extract(NEW.row_json, '$.recovered') = 1
          AND json_extract(NEW.row_json, '$.kind') = '${kind}'
          AND NEW.seq > ${before.cursor.sequence + 1}
        BEGIN SELECT RAISE(ABORT, 'later settlement row rejected'); END`)

      expect(await settle()).toMatchObject({ ok: false })
      expect(sawEarlierInserts[0]).toBeGreaterThan(0)
      expect(rows()).toEqual(diskBefore)
      expect(journal.cursor()).toEqual(before.cursor)
      expect(journal.snapshot()).toEqual(before)
      expect(published).toEqual([])
      expect(frames).toEqual([])

      vi.restoreAllMocks()

      const other = await open('other-chat')
      await expect(
        other.appendSubmission({
          clientMessageId: 'unrelated',
          payloadFingerprint: 'other',
          fence: 0,
          body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] }
        })
      ).resolves.toMatchObject({ sequence: 2 })

      database.db.exec('DROP TRIGGER reject_later_settlement')
      vi.spyOn(database, 'transaction').mockImplementation((run) =>
        transaction((db) => {
          const result = run(db)
          expect(journal.snapshot()).toEqual(before)
          expect(published).toEqual([])
          expect(frames).toEqual([])
          return result
        })
      )
      expect(await settle()).toEqual({ ok: true })
      vi.restoreAllMocks()
      const settled = journal.snapshot()
      expect(published).toEqual([settled])
      expect(frames.length).toBeGreaterThan(0)
      expect(
        emittedStates.every((state) => state.cursor.sequence === settled.cursor.sequence)
      ).toBe(true)
      expect(
        emittedStates.every((state) =>
          state.items.every(
            (item) => item.body.kind !== 'tool-call' || item.body.state === 'failed'
          )
        )
      ).toBe(true)
      expect(frames.at(-1)).toMatchObject({ type: 'batch', batch: { cursor: settled.cursor } })
      const frameCount = frames.length
      expect(settled.submissions[0]).toMatchObject({ dispatchState: 'unknown', recovered: true })
      expect(journal.activeTurnId()).toBeNull()
      const calls = settled.items.filter((item) => item.body.kind === 'tool-call')
      expect(calls).toHaveLength(201)
      expect(
        calls.every((item) => item.body.kind === 'tool-call' && item.body.state === 'failed')
      ).toBe(true)
      expect(calls[0]).toMatchObject({
        observedAt: 1_000,
        agentId: 'child',
        revision: 2,
        body: { endedAs: 'interrupted', input: { content: '界😀'.repeat(220_000) } }
      })
      const committed = rows().slice(diskBefore.length)
      expect(committed.map((row) => row.kind)).toEqual([
        'dispatch',
        'lifecycle-batch',
        'item',
        'lifecycle-batch',
        'lifecycle-batch'
      ])
      expect(committed.every((row) => row.recovered)).toBe(true)
      expect(await settle()).toEqual({ ok: true })
      expect(journal.snapshot()).toEqual(settled)
      expect(rows().slice(diskBefore.length)).toEqual(committed)
      expect(published).toEqual([settled])
      expect(frames).toHaveLength(frameCount)
      await journal.close()
      journal = await open()
      expect(journal.snapshot()).toEqual(settled)
      expect(await settle()).toEqual({ ok: true })
      expect(journal.snapshot()).toEqual(settled)
    }
  )

  it('writes an all-oversized settlement with full bodies, and deduplicates it after replay', async () => {
    await seedWork(2)
    const calls = journal.snapshot().items.filter((item) => item.body.kind === 'tool-call')
    const mutations: JournalLifecycleMutationInput[] = calls.map((item, index) => ({
      kind: 'item',
      identity: { provider: 'orca', clientMessageId: `call-${index}` },
      body: {
        kind: 'tool-call',
        name: 'Write',
        state: 'failed',
        endedAs: 'interrupted',
        input: { content: 'x'.repeat(MAX_JOURNAL_LIFECYCLE_BATCH_BYTES + index) }
      },
      turnScope: item.turnScope ?? AGENT_JOURNAL_THREAD_SCOPE
    }))
    const input = { settlementId: 'all-oversized:7', fence: 7, recovered: true as const, mutations }
    const before = journal.cursor()
    const published: AgentJournalSnapshot[] = []
    journal.observeCommits(() => published.push(journal.snapshot()))
    await journal.appendLifecycleBatch(input)
    const settled = journal.snapshot()
    expect(journal.cursor().sequence).toBe(before.sequence + 2)
    expect(
      rows()
        .slice(-2)
        .map((row) => row.kind)
    ).toEqual(['item', 'item'])
    expect(
      settled.items.filter((item) => item.body.kind === 'tool-call').map((item) => item.body)
    ).toEqual(mutations.flatMap((mutation) => (mutation.kind === 'item' ? [mutation.body] : [])))
    expect(published).toEqual([settled])
    await journal.appendLifecycleBatch(input)
    expect(journal.snapshot()).toEqual(settled)
    expect(published).toEqual([settled])
    expect(
      await journal.appendSteps([
        {
          kind: 'settlement',
          batch: {
            settlementId: input.settlementId,
            fence: input.fence,
            recovered: true,
            resolve: () => mutations
          }
        }
      ])
    ).toEqual([false])
    expect(journal.snapshot()).toEqual(settled)
    await journal.close()
    journal = await open()
    await journal.appendLifecycleBatch(input)
    expect(journal.snapshot()).toEqual(settled)
  })

  it('settles stale work through the same oversized fallback without duplicating its outcome', async () => {
    await seedWork(1)
    const input = {
      journal,
      sessionId: SESSION,
      fence: 8,
      acquisitionGeneration: 'new-generation',
      deathEvidence: {
        kind: 'exit-observed' as const,
        ownerFence: 7,
        observedAt: 1_000,
        detail: ''
      }
    }
    expect(await settleStaleStructuredAgentSessionState(input)).toBeGreaterThan(0)
    const settled = journal.snapshot()
    expect(await settleStaleStructuredAgentSessionState(input)).toBe(0)
    expect(journal.snapshot()).toEqual(settled)
    expect(rows().some((row) => row.kind === 'item' && row.recovered)).toBe(true)
  })

  it('uses an ordinary recovered tombstone when the settlement namespace exceeds the batch cap', async () => {
    const identity = { provider: 'orca' as const, clientMessageId: 'remove-item' }
    await journal.appendItem(
      identity,
      { kind: 'status', text: 'remove me' },
      {
        fence: 7,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      }
    )
    const before = journal.cursor()
    const input = {
      settlementId: 'x'.repeat(MAX_JOURNAL_LIFECYCLE_BATCH_BYTES),
      fence: 7,
      recovered: true as const,
      mutations: [{ kind: 'tombstone' as const, identity }]
    }
    await journal.appendLifecycleBatch(input)
    expect(journal.snapshot().items).toEqual([])
    expect(journal.cursor().sequence).toBe(before.sequence + 1)
    expect(rows().at(-1)).toMatchObject({ kind: 'tombstone', recovered: true })
    await journal.appendLifecycleBatch(input)
    expect(journal.cursor().sequence).toBe(before.sequence + 1)
  })

  it.each(['startup', 'stop'] as const)(
    'rolls back the %s submission verdict with its oversized item',
    async (mode) => {
      await journal.appendSubmission({
        clientMessageId: 'unanswered',
        payloadFingerprint: 'unanswered',
        fence: 7,
        handoverRecorded: true,
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'next' }] }
      })
      await journal.resolveDispatch({
        clientMessageId: 'unanswered',
        state: 'pending',
        fence: 7,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      })
      if (mode === 'stop') {
        await journal.appendStopEvent({ reason: 'user-stop' }, 7)
      }
      await journal.appendItem(
        { provider: 'orca', clientMessageId: 'oversized-call' },
        {
          kind: 'tool-call',
          name: 'Write',
          input: 'x'.repeat(MAX_JOURNAL_LIFECYCLE_BATCH_BYTES),
          state: 'running'
        },
        { fence: 7, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
      const input = {
        journal,
        sessionId: SESSION,
        fence: 7,
        settlementId: `${mode}:7`,
        verdict: { state: 'interrupted' as const, completedAt: 1_000 },
        pendingSubmissionReason: 'owner exited',
        showUnexpectedExitOutcome: mode === 'startup',
        ...(mode === 'startup' ? { exitedDuringStartup: { generation: 'start-7' } } : {})
      }
      const database = openTestJournalHostDatabase(root)
      const before = journal.snapshot()
      const diskBefore = rows()
      const published: AgentJournalSnapshot[] = []
      journal.observeCommits(() => published.push(journal.snapshot()))
      database.db.exec(`CREATE TEMP TRIGGER reject_submission_settlement_item
      BEFORE INSERT ON journal_rows
      WHEN NEW.session_id = '${SESSION}' AND json_extract(NEW.row_json, '$.recovered') = 1
        AND json_extract(NEW.row_json, '$.kind') = 'item'
      BEGIN SELECT RAISE(ABORT, 'item rejected after submission'); END`)
      expect(await settleStructuredAgentSessionDeadGeneration(input)).toMatchObject({ ok: false })
      expect(journal.snapshot()).toEqual(before)
      expect(rows()).toEqual(diskBefore)
      expect(published).toEqual([])
      database.db.exec('DROP TRIGGER reject_submission_settlement_item')
      expect(await settleStructuredAgentSessionDeadGeneration(input)).toEqual({ ok: true })
      expect(journal.submission('unanswered')).toMatchObject({
        dispatchState: 'rejected',
        recovered: true,
        rejection: { kind: mode === 'stop' ? 'cancelled' : 'providerStartFailed' }
      })
      const committed = rows().slice(diskBefore.length)
      expect(committed.filter((row) => row.kind === 'dispatch')).toHaveLength(1)
      expect(published).toEqual([journal.snapshot()])
      expect(await settleStructuredAgentSessionDeadGeneration(input)).toEqual({ ok: true })
      expect(rows().slice(diskBefore.length)).toEqual(committed)
      expect(published).toHaveLength(1)
    }
  )
})
