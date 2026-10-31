import { afterEach, expect, it, vi } from 'vitest'
import { MessageQuestionContributors } from '../message-question-contributors'
import { currentMessageQuestionView } from '../../../shared/agent-session-current-requests'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import {
  currentJournal,
  currentWork
} from './structured-agent-session-leftover-settlement.test-fixture'
import { observeAsyncQuestions } from './structured-agent-session-question-observation.test-fixture'
import { asyncQuestionBody } from './structured-agent-session-async-question.test-fixture'
import {
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD
} from './structured-agent-session-host-test-data'

let rig: QueuedMessageTestRig | undefined
afterEach(async () => {
  await rig?.dispose()
  rig = undefined
  vi.restoreAllMocks()
})

it.each([
  { first: 'delivery', cold: false },
  { first: 'stop', cold: false },
  { first: 'delivery', cold: true },
  { first: 'stop', cold: true }
] as const)(
  'retains the first scoped terminal fact through failed creation/Cancel/replay: %o',
  async ({ first, cold }) => {
    rig = await createQueuedMessageTestRig({ restartable: true })
    const current = rig
    await current.workingSend()
    const journal = currentJournal(current)
    const identity = { provider: 'codex' as const, threadId: THREAD, turnId: 'T1', ordinal: 0 }
    const root = await journal.appendItem(
      identity,
      { kind: 'turn', turnId: 'T1', state: 'running' },
      { fence: 1 }
    )
    const scope = { kind: 'turn' as const, turnItemId: root.itemId }
    const q1 = await journal.appendItem({ ...identity, ordinal: 1 }, asyncQuestionBody('q1'), {
      fence: 1,
      turnScope: scope
    })
    const observed = await observeAsyncQuestions(current, 'scoped-order')
    const db = openTestJournalHostDatabase(current.root).db
    let release = () => {}
    let receipt: Promise<void> | undefined
    try {
      await vi.waitFor(() => expect(currentMessageQuestionView(observed.state())?.ready).toBe(true))
      const ids = observed.state().asyncQuestions!.map((record) => record.id)
      expect(ids).toHaveLength(1)
      const target = ids[0]
      // Failed Q2 creation must also roll back Q1 settlement, leaving the real target transaction to repair it.
      db.exec(`CREATE TEMP TRIGGER fail_q2 BEFORE INSERT ON message_question_occurrences
      WHEN NEW.occurrence_id <> '${target}' BEGIN SELECT RAISE(ABORT, 'isolated Q2 failure'); END`)
      const lifetime = current.host.collaboratorsForTests().lifetime
      const conversation = lifetime.conversation.bind(lifetime)
      let enter!: () => void
      const entered = new Promise<void>((resolve) => {
        enter = resolve
      })
      const dispatch = new Promise<void>((resolve) => {
        release = resolve
      })
      if (!cold) {
        vi.spyOn(lifetime, 'conversation').mockImplementationOnce(async (...args) => {
          const session = await conversation(...args)
          enter()
          await dispatch
          return session
        })
        receipt = current.host.cancelCurrentQuestions({ sessionId: SESSION, ids }, 'phone')
        void receipt.catch(() => {})
        await entered
      }
      // Admit Q2 before either boundary, so no observer can persist Q1's outcome in between.
      await journal.appendItem({ ...identity, ordinal: 2 }, asyncQuestionBody('q2'), {
        fence: 1,
        turnScope: scope
      })
      const deliver = () =>
        journal.appendItem(
          { ...identity, turnId: 'U', ordinal: 0 },
          {
            kind: 'message',
            role: 'user',
            blocks: [{ type: 'text', text: 'ordinary delivered answer' }]
          },
          { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
        )
      // This timestamp deliberately precedes Q1 creation: only canonical mutation order can choose the winner.
      const stop = () =>
        journal.appendItem(
          identity,
          {
            kind: 'turn',
            turnId: 'T1',
            state: 'interrupted',
            outcome: 'cancellation',
            completedAt: 1
          },
          { fence: 1 }
        )
      let delivery
      let stopped
      if (first === 'delivery') {
        delivery = await deliver()
        stopped = await stop()
      } else {
        stopped = await stop()
        delivery = await deliver()
      }
      // A later cancelled revision must not move the original Stop boundary after U on cold replay.
      await stop()
      expect(journal.item(root.itemId)?.sequence).toBe(root.cursor.sequence)
      expect(journal.questionSourceFacts().interruptedTurns.get(root.itemId)?.order).toEqual([
        stopped.cursor.sequence,
        0
      ])
      await current.host.flushStreamedEvents(SESSION)
      const savedPending = () =>
        JSON.parse(
          String(
            db
              .prepare(
                'SELECT record_json FROM message_question_occurrences WHERE occurrence_id = ?'
              )
              .get(target)?.record_json
          )
        )
      expect(savedPending().resolution.state).toBe('pending')
      observed.close()
      if (cold) {
        await current.restartHostProcess()
        await current.host.history({ sessionId: SESSION, direction: 'tail' })
        expect(currentJournal(current)).not.toBe(journal)
        expect(
          currentJournal(current).questionSourceFacts().interruptedTurns.get(root.itemId)?.order
        ).toEqual([stopped.cursor.sequence, 0])
        receipt = current.host.cancelCurrentQuestions({ sessionId: SESSION, ids }, 'phone')
        void receipt.catch(() => {})
      } else {
        release()
      }
      const dispatches = current.dispatch.mock.calls.length
      const stops = current.cancelTurn.mock.calls.length
      await expect(receipt).resolves.toBeUndefined()
      const expected =
        first === 'delivery'
          ? { state: 'resolved', reason: 'delivery', factId: delivery.itemId }
          : { state: 'cancelled', reason: 'interruption', factId: root.itemId }
      expect(savedPending().resolution).toMatchObject(expected)
      const payload = currentWork(current).requestProjection(
        SESSION,
        'agent-session.current-requests.v2'
      ).items
      expect(payload && !Array.isArray(payload) && payload.asyncQuestions).toBe(null)
      db.exec('DROP TRIGGER fail_q2')
      const recovered = await observeAsyncQuestions(current, 'scoped-recovered')
      try {
        await vi.waitFor(
          () => expect(currentMessageQuestionView(recovered.state())?.ready).toBe(true),
          { timeout: 10_000 }
        )
        expect(savedPending().resolution).toMatchObject(expected)
        // Q2 shared the same outgoing segment, and may not reopen after recovery either.
        expect(recovered.state().asyncQuestions).toEqual([])
      } finally {
        recovered.close()
      }
      await current.restartHostProcess()
      await current.host.history({ sessionId: SESSION, direction: 'tail' })
      const owner = currentJournal(current).messageQuestions()
      expect(
        owner.repository
          .current(owner.source)
          .records.find((record) => record.sourceRowId === q1.itemId)?.resolution
      ).toMatchObject(expected)
      expect(current.dispatch.mock.calls).toHaveLength(dispatches)
      expect(current.cancelTurn.mock.calls).toHaveLength(stops)
    } finally {
      release()
      await receipt?.catch(() => {})
      db.exec('DROP TRIGGER IF EXISTS fail_q2')
      observed.close()
    }
  }
)

it.each([10, 100])(
  'drains each outgoing scoped contributor once across %i delivered boundaries',
  async (count) => {
    rig = await createQueuedMessageTestRig()
    const current = rig
    await current.workingSend()
    const journal = currentJournal(current)
    const deliveries: string[] = []
    for (let index = 0; index < count; index++) {
      const identity = {
        provider: 'codex' as const,
        threadId: THREAD,
        turnId: `T${index}`,
        ordinal: 0
      }
      const root = await journal.appendItem(
        identity,
        { kind: 'turn', turnId: identity.turnId, state: 'running' },
        { fence: 1 }
      )
      await journal.appendItem({ ...identity, ordinal: 1 }, asyncQuestionBody(`q${index}`), {
        fence: 1,
        turnScope: { kind: 'turn', turnItemId: root.itemId }
      })
      const delivery = await journal.appendItem(
        { ...identity, ordinal: 2 },
        {
          kind: 'message',
          role: 'user',
          blocks: [{ type: 'text', text: 'delivered' }]
        },
        { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
      deliveries.push(delivery.itemId)
      await journal.appendItem(
        identity,
        { kind: 'turn', turnId: identity.turnId, state: 'interrupted', outcome: 'cancellation' },
        { fence: 1 }
      )
    }
    const removals = vi.spyOn(MessageQuestionContributors.prototype, 'remove')
    const boundaryDrains = vi.spyOn(MessageQuestionContributors.prototype, 'takeContext')
    const payload = currentWork(current).requestProjection(
      SESSION,
      'agent-session.current-requests.v2'
    ).items
    expect(payload && !Array.isArray(payload) && payload.asyncQuestions).toEqual([])
    const owner = journal.messageQuestions()
    const records = owner.repository.current(owner.source).records
    expect(records).toHaveLength(count)
    expect(records.map((record) => record.resolution)).toEqual(
      deliveries.map((factId) =>
        expect.objectContaining({
          state: 'resolved',
          reason: 'delivery',
          factId
        })
      )
    )
    // Membership lookup/removal is direct; settled contributors are never enumerated by later U boundaries.
    expect(removals.mock.calls.length).toBeGreaterThanOrEqual(count)
    expect(removals.mock.calls.length).toBeLessThanOrEqual(2 * count + 4)
    expect(boundaryDrains.mock.calls.length).toBeLessThanOrEqual(count + 4)
    const removed = removals.mock.calls.length
    currentWork(current).requestProjection(SESSION, 'agent-session.current-requests.v2')
    expect(removals.mock.calls).toHaveLength(removed)
  }
)
