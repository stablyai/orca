import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { afterEach, expect, it, vi } from 'vitest'
import { createCodexStructuredItemStreams } from '../../codex/codex-structured-item-streams'
import { appendCodexItemAndPublish } from '../../codex/codex-structured-journal-sink'
import { codexJournalItem } from '../../codex/codex-structured-item-translation'
import { MessageQuestionIngest } from '../message-question-ingest'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { messageQuestionOccurrenceSchema } from '../../../shared/message-question-occurrence'
import * as asks from '../../../shared/native-chat/input/native-chat-ask'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import {
  currentJournal,
  currentWork
} from './structured-agent-session-leftover-settlement.test-fixture'
import {
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import { asyncQuestionBody } from './structured-agent-session-async-question.test-fixture'
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

it.each([10, 100].flatMap((count) => [1000, 10000].map((bytes) => ({ count, bytes }))))(
  'reuses $count historical definitions of $bytes bytes across real Codex command checkpoints and partial delta pages',
  async ({ count, bytes }) => {
    rig = await createQueuedMessageTestRig()
    const current = rig
    await current.workingSend()
    const journal = currentJournal(current)
    for (let i = 0; i < count; i++) {
      const body = asyncQuestionBody(`q-${i}`)
      if (body.kind !== 'message') {
        throw new Error('Expected message fixture')
      }
      await journal.appendItem(
        { provider: 'codex', threadId: THREAD, turnId: 'questions', ordinal: i },
        {
          ...body,
          blocks: body.blocks.map((block) =>
            block.type === 'tool-call'
              ? {
                  ...block,
                  input: { questions: [{ title: `q-${i}`, options: ['x'.repeat(bytes)] }] }
                }
              : block
          )
        },
        { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
    }
    const payload = () =>
      currentWork(current).requestProjection(SESSION, 'agent-session.current-requests.v2').items
    const before = payload()
    expect(before && !Array.isArray(before) && before.asyncQuestions).toHaveLength(count)
    const sink = current.providerEvents()
    const identity = { provider: 'codex' as const, threadId: THREAD, turnId: 'shell', ordinal: 0 }
    const item = {
      id: 'shell',
      type: 'commandExecution',
      command: 'printf output',
      status: 'inProgress'
    }
    const body = codexJournalItem(item).body
    if (!body) {
      throw new Error('Expected command translation')
    }
    expect(
      appendCodexItemAndPublish(sink, identity, body, { turnScope: AGENT_JOURNAL_THREAD_SCOPE })
        .accepted
    ).toBe(true)
    await current.host.flushStreamedEvents(SESSION)
    // A new command is not a question; establish it before measuring revisions.
    expect(payload()).toBe(before)
    const streams = createCodexStructuredItemStreams({
      sink,
      turnIdFor: () => 'shell',
      identityFor: () => identity,
      attributionFor: () => ({ turnScope: AGENT_JOURNAL_THREAD_SCOPE })
    })
    streams.track(THREAD, 'shell', item, identity)
    const parse = vi.spyOn(asks, 'parseAskFromToolInput')
    const append = vi.spyOn(MessageQuestionIngest.prototype, 'append')
    const repository = journal.messageQuestions().repository
    const reconcile = vi.spyOn(repository, 'reconcile')
    const schema = vi.spyOn(messageQuestionOccurrenceSchema, 'parse')
    const deltas = vi.spyOn(journal, 'readSince')
    const metadata = vi.spyOn(journal, 'visitItems')
    const serialize = vi.spyOn(JSON, 'stringify')
    try {
      // More than one 256-row delta page, preserving the real producer and checkpoint cadence.
      for (let i = 0; i < 300; i++) {
        expect(
          streams.handle(THREAD, 'item/commandExecution/outputDelta', {
            itemId: 'shell',
            delta: 'output '.repeat(32)
          }).admission.accepted
        ).toBe(true)
        expect(streams.flush()).toBe(true)
        if (i % 20 === 19) {
          await current.host.flushStreamedEvents(SESSION)
        }
      }
      await current.host.flushStreamedEvents(SESSION)
      expect(payload()).toBe(before)
      const completed = codexJournalItem({
        ...item,
        status: 'completed',
        aggregatedOutput: 'complete'
      }).body
      if (!completed) {
        throw new Error('Expected completed command translation')
      }
      appendCodexItemAndPublish(sink, identity, completed, {
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      })
      await current.host.flushStreamedEvents(SESSION)
      expect(payload()).toBe(before)
      expect(journal.item(agentJournalItemKey(identity))?.body).toMatchObject({
        kind: 'tool-call',
        state: 'completed'
      })
      expect(append).not.toHaveBeenCalled()
      expect(reconcile).not.toHaveBeenCalled()
      expect(schema).not.toHaveBeenCalled()
      expect(parse.mock.calls.filter(([name]) => name === 'request_user_input_async')).toHaveLength(
        0
      )
      expect(
        serialize.mock.calls.filter(
          ([value]) =>
            typeof value === 'object' &&
            value !== null &&
            ('questions' in value || 'asyncQuestions' in value)
        )
      ).toHaveLength(0)
      expect(deltas.mock.calls.length).toBeGreaterThanOrEqual(3)
      expect(
        deltas.mock.results.some(
          (result) =>
            result.type === 'return' && result.value.ok && result.value.rows.length === 256
        )
      ).toBe(true)
      console.log('codex-question-delta-work', {
        count,
        bytes,
        deltaReads: deltas.mock.calls.length,
        metadataVisits: metadata.mock.calls.length,
        checkpoints: 300
      })
      serialize.mockRestore()
      await journal.appendItem(
        { provider: 'codex', threadId: THREAD, turnId: 'new', ordinal: 0 },
        asyncQuestionBody('new'),
        { fence: 1 }
      )
      const changed = payload()
      expect(changed && !Array.isArray(changed) && changed.asyncQuestions).toHaveLength(count + 1)
      expect(reconcile).toHaveBeenCalled()
      await journal.appendItem(
        { provider: 'codex', threadId: THREAD, turnId: 'answer', ordinal: 0 },
        { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'answered' }] },
        { fence: 1 }
      )
      const answered = payload()
      expect(answered && !Array.isArray(answered) && answered.asyncQuestions).toEqual([])
    } finally {
      streams.dispose()
    }
  },
  30_000
)

it('retains failed prepared definitions and their retry deadline across real command output', async () => {
  rig = await createQueuedMessageTestRig()
  const current = rig
  await current.workingSend()
  const journal = currentJournal(current)
  const sink = current.providerEvents()
  const identity = { provider: 'codex' as const, threadId: THREAD, turnId: 'shell', ordinal: 0 }
  const item = {
    id: 'shell',
    type: 'commandExecution',
    command: 'printf output',
    status: 'inProgress'
  }
  const body = codexJournalItem(item).body
  if (!body) {
    throw new Error('Expected command translation')
  }
  appendCodexItemAndPublish(sink, identity, body, { turnScope: AGENT_JOURNAL_THREAD_SCOPE })
  await current.host.flushStreamedEvents(SESSION)
  const payload = () =>
    currentWork(current).requestProjection(SESSION, 'agent-session.current-requests.v2').items
  payload()
  const database = openTestJournalHostDatabase(current.root)
  database.db.exec(
    "CREATE TEMP TRIGGER fail_question BEFORE INSERT ON message_question_occurrences BEGIN SELECT RAISE(ABORT, 'creation unavailable'); END"
  )
  const streams = createCodexStructuredItemStreams({
    sink,
    turnIdFor: () => 'shell',
    identityFor: () => identity,
    attributionFor: () => ({ turnScope: AGENT_JOURNAL_THREAD_SCOPE })
  })
  streams.track(THREAD, 'shell', item, identity)
  let clock = Date.now()
  vi.spyOn(Date, 'now').mockImplementation(() => clock)
  try {
    await journal.appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'questions', ordinal: 0 },
      asyncQuestionBody('retained-work'),
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    const unknown = payload()
    expect(unknown && !Array.isArray(unknown) && unknown.asyncQuestions).toBe(null)
    const append = vi.spyOn(MessageQuestionIngest.prototype, 'append')
    const reconcile = vi.spyOn(journal.messageQuestions().repository, 'reconcile')
    for (let i = 0; i < 3; i++) {
      streams.handle(THREAD, 'item/commandExecution/outputDelta', {
        itemId: 'shell',
        delta: 'working '.repeat(32)
      })
      expect(streams.flush()).toBe(true)
      await current.host.flushStreamedEvents(SESSION)
      expect(payload()).toBe(unknown)
    }
    expect(append).not.toHaveBeenCalled()
    expect(reconcile).not.toHaveBeenCalled()
    database.db.exec('DROP TRIGGER fail_question')
    expect(payload()).toBe(unknown)
    clock += 751
    const recovered = payload()
    expect(recovered && !Array.isArray(recovered) && recovered.asyncQuestions).toHaveLength(1)
    expect(append).not.toHaveBeenCalled()
    expect(reconcile).toHaveBeenCalledTimes(1)
  } finally {
    streams.dispose()
    database.db.exec('DROP TRIGGER IF EXISTS fail_question')
  }
})
