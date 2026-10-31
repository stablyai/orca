import { afterEach, expect, it, vi } from 'vitest'
import { failQuestionReadAfterTargetCommit } from '../message-question-read-failure.test-fixture'
import {
  currentMessageQuestionView,
  hasCompleteBlockingRequests
} from '../../../shared/agent-session-current-requests'
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
  'cancel',
  'delivery-stop',
  'delivery-clear',
  'target-write',
  'publication',
  'postcommit-read'
] as const)('commits only saved targets during unrelated creation failure: %s', async (kind) => {
  rig = await createQueuedMessageTestRig({ restartable: true })
  const current = rig
  await current.workingSend()
  const journal = currentJournal(current)
  const attrs = { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  const append = (ordinal: number, body: Parameters<typeof journal.appendItem>[1]) =>
    journal.appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'saved-target', ordinal },
      body,
      attrs
    )
  const q1 = await append(1, asyncQuestionBody('q1'))
  const observed = await observeAsyncQuestions(current, `saved-${kind}`)
  const db = openTestJournalHostDatabase(current.root).db
  const owner = journal.messageQuestions()
  let releaseDispatch = () => {}
  let receipt: Promise<void> | undefined
  let sourceRead: ReturnType<typeof failQuestionReadAfterTargetCommit> | undefined
  try {
    await vi.waitFor(() => expect(currentMessageQuestionView(observed.state())?.ready).toBe(true))
    const displayed = observed.state().asyncQuestions!.map((record) => record.id)
    expect(displayed).toHaveLength(1)
    const target = displayed[0]
    db.exec(`CREATE TEMP TRIGGER fail_unrelated BEFORE INSERT ON message_question_occurrences
        WHEN NEW.occurrence_id <> '${target}' BEGIN SELECT RAISE(ABORT, 'isolated Q2 creation'); END`)
    if (kind === 'target-write') {
      db.exec(
        "CREATE TEMP TRIGGER fail_target BEFORE UPDATE ON message_question_occurrences BEGIN SELECT RAISE(ABORT, 'target write failed'); END"
      )
    }
    const lifetime = current.host.collaboratorsForTests().lifetime
    const conversation = lifetime.conversation.bind(lifetime)
    let entered!: () => void
    const dispatched = new Promise<void>((resolve) => {
      entered = resolve
    })
    const delivery = new Promise<void>((resolve) => {
      releaseDispatch = resolve
    })
    vi.spyOn(lifetime, 'conversation').mockImplementationOnce(async (...args) => {
      const session = await conversation(...args)
      entered()
      await delivery
      return session
    })
    // The real host/channel call captures the ready IDs before Q2 admission; only delivery waits.
    receipt = current.host.cancelCurrentQuestions({ sessionId: SESSION, ids: displayed }, 'phone')
    void receipt.catch(() => {})
    await dispatched
    if (kind.startsWith('delivery')) {
      await append(2, {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: 'delivered answer' }]
      })
      await append(
        3,
        kind === 'delivery-clear'
          ? {
              kind: 'status',
              text: 'Context cleared',
              contextClear: { operationId: 'clear', afterFence: 1, clearedAt: 1 }
            }
          : { kind: 'status', text: 'Conversation interrupted' }
      )
    }
    await append(0, {
      kind: 'approval',
      title: 'Independent blocking',
      detail: null,
      options: [{ id: 'yes', label: 'Allow' }],
      resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
    })
    const q2 = await append(4, asyncQuestionBody('q2'))
    await current.host.flushStreamedEvents(SESSION)
    await vi.waitFor(() => {
      expect(currentMessageQuestionView(observed.state())?.ready).toBe(false)
      expect(hasCompleteBlockingRequests(observed.state())).toBe(true)
    })
    expect(
      owner.repository
        .current(owner.source)
        .records.some((record) => record.sourceRowId === q2.itemId)
    ).toBe(false)
    const dispatches = current.dispatch.mock.calls.length
    const stops = current.cancelTurn.mock.calls.length
    await expect(
      current.host.cancelCurrentQuestions(
        { sessionId: SESSION, ids: [...displayed, 'unknown'] },
        'phone'
      )
    ).rejects.toThrow('does not belong')
    const publication =
      kind === 'publication'
        ? vi.spyOn(currentWork(current), 'requestProjection').mockImplementation(() => {
            throw new Error('publication failed')
          })
        : undefined
    sourceRead =
      kind === 'postcommit-read' ? failQuestionReadAfterTargetCommit(db, target) : undefined
    releaseDispatch()
    if (kind === 'target-write') {
      await expect(receipt).rejects.toThrow('target write failed')
      db.exec('DROP TRIGGER fail_target')
    } else {
      await expect(receipt).resolves.toBeUndefined()
    }
    publication?.mockRestore()
    if (sourceRead) {
      const unavailable = currentWork(current).requestProjection(
        SESSION,
        'agent-session.current-requests.v2'
      ).items
      expect(unavailable && !Array.isArray(unavailable) && unavailable.asyncQuestions).toBe(null)
      expect(unavailable && !Array.isArray(unavailable) && unavailable.blocking).toHaveLength(1)
      await vi.waitFor(() => expect(sourceRead?.failedReads()).toBeGreaterThan(0), {
        timeout: 10_000
      })
      sourceRead.restore()
    }
    const saved = owner.repository
      .current(owner.source)
      .records.find((record) => record.id === target)
    expect(saved?.sourceRowId).toBe(q1.itemId)
    expect(saved?.resolution).toMatchObject(
      kind.startsWith('delivery')
        ? { state: 'resolved', reason: 'delivery' }
        : kind === 'target-write'
          ? { state: 'pending' }
          : { state: 'cancelled', reason: 'user' }
    )
    const payload = currentWork(current).requestProjection(
      SESSION,
      'agent-session.current-requests.v2'
    ).items
    expect(payload && !Array.isArray(payload) && payload.asyncQuestions).toBe(null)
    expect(payload && !Array.isArray(payload) && payload.blocking).toHaveLength(1)
    expect(current.dispatch.mock.calls).toHaveLength(dispatches)
    expect(current.cancelTurn.mock.calls).toHaveLength(stops)
    db.exec('DROP TRIGGER fail_unrelated')
    // The already-active shared reader retries the stable null publication after storage recovers.
    await vi.waitFor(() => expect(currentMessageQuestionView(observed.state())?.ready).toBe(true), {
      timeout: 10_000
    })
    expect(observed.state().asyncQuestions?.map((record) => record.sourceRowId)).toEqual(
      kind === 'target-write' ? [q1.itemId, q2.itemId] : [q2.itemId]
    )
    observed.close()
    await current.restartHostProcess()
    await current.host.history({ sessionId: SESSION, direction: 'tail' })
    const reopened = currentJournal(current).messageQuestions()
    const reopenedTarget = reopened.repository
      .current(reopened.source)
      .records.find((record) => record.id === target)
    expect(reopenedTarget?.resolution).toEqual(saved?.resolution)
  } finally {
    releaseDispatch()
    await receipt?.catch(() => {})
    sourceRead?.restore()
    db.exec('DROP TRIGGER IF EXISTS fail_unrelated; DROP TRIGGER IF EXISTS fail_target')
    observed.close()
  }
})
