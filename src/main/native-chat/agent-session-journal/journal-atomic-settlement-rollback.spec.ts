import type { createFixture } from './journal-atomic-settlement-contract-test-fixture'
import { expect, it, vi } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalSnapshot
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session-wire'
import { AgentSessionSubscribers } from '../agent-session-wire/structured-agent-session-subscribers'
import { settleStaleStructuredAgentSessionState } from '../agent-session-wire/structured-agent-session-dead-generation-settlement'
import { openTestJournalHostDatabase } from './journal-host-database-test-support'
import type { JournalLifecycleMutationInput } from './journal-row-builders'
import { MAX_JOURNAL_LIFECYCLE_BATCH_BYTES } from './journal-row-schema'

export function registerJournalAtomicSettlementRollbackTests(
  fixture: ReturnType<typeof createFixture>
): void {
  it.each(['item', 'lifecycle-batch'] as const)(
    'rolls back a later %s rejection, publishes nothing, then retries exactly once',
    async (kind) => {
      await fixture.seedWork()
      const database = openTestJournalHostDatabase(fixture.root)
      const before = fixture.journal.snapshot()
      const diskBefore = fixture.rows()
      const published: AgentJournalSnapshot[] = []
      const frames: AgentSessionSubscribeEvent[] = []
      const emittedStates: AgentJournalSnapshot[] = []
      const subscribers = new AgentSessionSubscribers()
      subscribers.open({
        id: 'reader',
        sessionId: fixture.SESSION,
        journal: fixture.journal,
        fence: 7,
        cursor: before.cursor,
        emit: (event) => {
          frames.push(event)
          emittedStates.push(fixture.journal.snapshot())
        }
      })
      frames.length = 0
      emittedStates.length = 0
      fixture.journal.observeCommits(() => {
        published.push(fixture.journal.snapshot())
        subscribers.publish(fixture.SESSION, fixture.journal)
      })
      const sawEarlierInserts: number[] = []
      const transaction = database.transaction.bind(database)
      vi.spyOn(database, 'transaction').mockImplementation((run, streamed, committed) =>
        transaction(
          (db) => {
            try {
              const result = run(db)
              expect(fixture.journal.snapshot()).toEqual(before)
              expect(published).toEqual([])
              expect(frames).toEqual([])
              return result
            } catch (error) {
              sawEarlierInserts.push(fixture.rows().length - diskBefore.length)
              expect(fixture.journal.snapshot()).toEqual(before)
              expect(published).toEqual([])
              expect(frames).toEqual([])
              throw error
            }
          },
          streamed,
          committed
        )
      )
      database.db.exec(`CREATE TEMP TRIGGER reject_later_settlement BEFORE INSERT ON journal_rows
      WHEN NEW.session_id = '${fixture.SESSION}' AND json_extract(NEW.row_json, '$.recovered') = 1
        AND json_extract(NEW.row_json, '$.kind') = '${kind}'
        AND NEW.seq > ${before.cursor.sequence + 1}
      BEGIN SELECT RAISE(ABORT, 'later settlement row rejected'); END`)

      expect(await fixture.settle()).toMatchObject({ ok: false })
      expect(sawEarlierInserts[0]).toBeGreaterThan(0)
      expect(fixture.rows()).toEqual(diskBefore)
      expect(fixture.journal.cursor()).toEqual(before.cursor)
      expect(fixture.journal.snapshot()).toEqual(before)
      expect(published).toEqual([])
      expect(frames).toEqual([])

      vi.restoreAllMocks()

      const other = await fixture.open('other-chat')
      await expect(
        other.appendSubmission({
          clientMessageId: 'unrelated',
          payloadFingerprint: 'other',
          fence: 0,
          body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] }
        })
      ).resolves.toMatchObject({ sequence: 2 })

      database.db.exec('DROP TRIGGER reject_later_settlement')
      vi.spyOn(database, 'transaction').mockImplementation((run, streamed, committed) =>
        transaction(
          (db) => {
            const result = run(db)
            expect(fixture.journal.snapshot()).toEqual(before)
            expect(published).toEqual([])
            expect(frames).toEqual([])
            return result
          },
          streamed,
          committed
        )
      )
      expect(await fixture.settle()).toMatchObject({ ok: true })
      vi.restoreAllMocks()
      const settled = fixture.journal.snapshot()
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
      expect(fixture.journal.runningTurn()?.turnId ?? null).toBeNull()
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
      const committed = fixture.rows().slice(diskBefore.length)
      expect(committed.map((row) => row.kind)).toEqual([
        'dispatch',
        'lifecycle-batch',
        'item',
        'lifecycle-batch',
        'lifecycle-batch'
      ])
      expect(committed.every((row) => row.recovered)).toBe(true)
      expect(await fixture.settle()).toMatchObject({ ok: true })
      expect(fixture.journal.snapshot()).toEqual(settled)
      expect(fixture.rows().slice(diskBefore.length)).toEqual(committed)
      expect(published).toEqual([settled])
      expect(frames).toHaveLength(frameCount)
      await fixture.journal.close()
      fixture.journal = await fixture.open()
      expect(fixture.journal.snapshot()).toEqual(settled)
      expect(await fixture.settle()).toMatchObject({ ok: true })
      expect(fixture.journal.snapshot()).toEqual(settled)
    }
  )

  it('writes an all-oversized settlement with full bodies, and deduplicates it after replay', async () => {
    await fixture.seedWork(2)
    const calls = fixture.journal.snapshot().items.filter((item) => item.body.kind === 'tool-call')
    const mutations: JournalLifecycleMutationInput[] = calls.map((item, index) => ({
      kind: 'item',
      observedAt: index + 1,
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
    const input = {
      settlementId: 'all-oversized:7',
      fence: 7,
      recovered: true as const,
      mutations
    }
    const before = fixture.journal.cursor()
    const published: AgentJournalSnapshot[] = []
    fixture.journal.observeCommits(() => published.push(fixture.journal.snapshot()))
    await fixture.journal.appendLifecycleBatch(input)
    const settled = fixture.journal.snapshot()
    expect(fixture.journal.cursor().sequence).toBe(before.sequence + 2)
    expect(
      fixture
        .rows()
        .slice(-2)
        .map((row) => row.kind)
    ).toEqual(['item', 'item'])
    expect(
      settled.items.filter((item) => item.body.kind === 'tool-call').map((item) => item.body)
    ).toEqual(mutations.flatMap((mutation) => (mutation.kind === 'item' ? [mutation.body] : [])))
    expect(
      fixture
        .rows()
        .slice(-2)
        .map((row) => row.ts)
    ).toEqual([1, 2])
    expect(
      settled.items.filter((item) => item.body.kind === 'tool-call').map((item) => item.observedAt)
    ).toEqual(calls.map((item) => item.observedAt))
    expect(published).toEqual([settled])
    await fixture.journal.appendLifecycleBatch(input)
    expect(fixture.journal.snapshot()).toEqual(settled)
    expect(published).toEqual([settled])
    expect(
      await fixture.journal.appendSteps([
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
    expect(fixture.journal.snapshot()).toEqual(settled)
    await fixture.journal.close()
    fixture.journal = await fixture.open()
    await fixture.journal.appendLifecycleBatch(input)
    expect(fixture.journal.snapshot()).toEqual(settled)
  })

  it('settles stale work through the same oversized fallback without duplicating its outcome', async () => {
    await fixture.seedWork(1)
    const input = {
      journal: fixture.journal,
      sessionId: fixture.SESSION,
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
    const settled = fixture.journal.snapshot()
    expect(await settleStaleStructuredAgentSessionState(input)).toBe(0)
    expect(fixture.journal.snapshot()).toEqual(settled)
    expect(fixture.rows().some((row) => row.kind === 'item' && row.recovered)).toBe(true)
  })
}
