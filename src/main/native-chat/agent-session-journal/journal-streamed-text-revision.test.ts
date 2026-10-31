import { expect, it, vi } from 'vitest'
import { createCodexJournalTranslator } from '../../codex/codex-structured-journal-translation'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type { JournalRow } from './journal-row-schema'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { codexImageItemBody } from '../../codex/codex-image-item-translation'
import { journalPragmaNumber } from './journal-database'
import { openTestJournalHostDatabase } from './journal-host-database-test-support'
import { openAgentSessionJournal } from './journal-store-factory'
import { createDeferredStructuredAgentSessionEventSink } from '../agent-session-wire/structured-agent-session-event-sink'
import { testEventSinkLogging } from '../agent-session-wire/structured-agent-session-logger-test-support'
import { createProviderTimelineAssembler } from '../agent-session-timeline/provider-timeline-assembler'
import { providerTimelineSink } from '../agent-session-timeline/provider-timeline-plan'
import { JournalGoalAttachmentInverse } from './journal-goal-attachment-inverse'
import * as attachmentReferences from '../agent-session-attachments/agent-session-attachment-references'

import {
  fixture,
  commitLevels,
  openJournal,
  text as fixtureText,
  uploadedInput
} from './journal-streamed-revision-contract-test-fixture'

const text = (role: 'assistant' | 'user' | 'reasoning', value: string): AgentJournalMessageItem =>
  role === 'reasoning'
    ? { kind: 'message', role, blocks: [{ type: 'text', text: value }] }
    : fixtureText(role, value)

it('keeps image and goal transitions FULL, streams text at NORMAL, and restores FULL', async () => {
  const database = openTestJournalHostDatabase(fixture.root)
  const levels: number[] = []
  database.transaction((db) => levels.push(journalPragmaNumber(db, 'synchronous')), true)
  levels.push(journalPragmaNumber(database.db, 'synchronous'))
  database.transaction((db) => levels.push(journalPragmaNumber(db, 'synchronous')))
  expect(() =>
    database.transaction(() => {
      throw new Error('rolled back')
    }, true)
  ).toThrow('rolled back')
  levels.push(journalPragmaNumber(database.db, 'synchronous'))
  expect(levels).toEqual([1, 2, 2, 2])
  const journal = await openAgentSessionJournal({
    database,
    identity: {
      sessionId: 'chat',
      workspaceId: 'workspace',
      hostId: 'host',
      agent: 'codex',
      providerHandle: null
    }
  })
  levels.length = 0
  const exec = database.db.exec.bind(database.db)
  const rollbacks: number[] = []
  vi.spyOn(database.db, 'exec').mockImplementation((sql) => {
    if (sql === 'COMMIT') {
      levels.push(journalPragmaNumber(database.db, 'synchronous'))
    }
    if (sql === 'ROLLBACK') {
      rollbacks.push(journalPragmaNumber(database.db, 'synchronous'))
    }
    exec(sql)
  })
  const image = { id: 'image', type: 'imageGeneration' }
  for (const body of [
    text('assistant', 'Generating image'),
    codexImageItemBody({ ...image, status: 'inProgress' }),
    codexImageItemBody({ ...image, status: 'completed', result: 'AAAA' }),
    text('assistant', 'Image preview unavailable'),
    { ...text('assistant', 'Goal'), sentAs: 'goal' as const },
    text('assistant', 'Goal reached'),
    { ...text('reasoning', 'Thinking'), state: 'running' as const },
    { ...text('reasoning', 'Thinking more'), state: 'running' as const },
    { ...text('reasoning', 'Done thinking'), state: 'completed' as const, completedAt: 100 },
    text('assistant', 'Answer')
  ]) {
    await journal.appendItem(
      { provider: 'codex', threadId: 'thread', turnId: 'turn', ordinal: 1 },
      body,
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
  }
  expect(levels).toEqual([2, 1, 2, 2, 2, 2, 2, 1, 2, 2])
  expect(journalPragmaNumber(database.db, 'synchronous')).toBe(2)
  levels.length = 0
  for (const options of [
    { recovered: true as const },
    { ownerFence: 2 },
    { executionOwner: 2 },
    { agentId: 'child', producerKind: 'agent' as const }
  ]) {
    await journal.appendSteps([
      {
        kind: 'item',
        resolve: () => ({
          identity: { provider: 'codex', threadId: 'thread', turnId: 'turn', ordinal: 1 },
          body: text('assistant', 'control transition')
        }),
        options: { fence: 2, turnScope: AGENT_JOURNAL_THREAD_SCOPE, ...options }
      }
    ])
  }
  // Existing items retain creation provenance; a caller's ownerFence hint changes no stored owner.
  expect(levels).toEqual([2, 1, 2, 2])
  const identity = { provider: 'orca' as const, clientMessageId: 'failed-stream' }
  await journal.appendItem(identity, text('assistant', 'before failure'), {
    fence: 2,
    turnScope: AGENT_JOURNAL_THREAD_SCOPE
  })
  database.db.exec(
    "CREATE TRIGGER reject_stream BEFORE INSERT ON journal_outcomes BEGIN SELECT RAISE(ABORT, 'stream insert failed'); END"
  )
  await expect(
    journal.appendSteps([
      {
        kind: 'item',
        resolve: () => ({ identity, body: text('assistant', 'failed') }),
        options: { fence: 2, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      }
    ])
  ).rejects.toThrow('stream insert failed')
  expect(rollbacks).toEqual([1])
  expect(journalPragmaNumber(database.db, 'synchronous')).toBe(2)
  expect(journal.snapshot().items.at(-1)?.body).toEqual(text('assistant', 'before failure'))
  database.db.exec('DROP TRIGGER reject_stream')
  levels.length = 0
  await journal.appendItem(identity, text('assistant', 'retry'), {
    fence: 2,
    turnScope: AGENT_JOURNAL_THREAD_SCOPE
  })
  expect(levels).toEqual([1])
  expect(journal.snapshot().items.at(-1)?.body).toEqual(text('assistant', 'retry'))
  await journal.close()
})

it.each([1, 10])(
  'commits %i real assembler windows at NORMAL with no attachment effects',
  async (count) => {
    const journal = await openJournal()
    const deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging('stream'))
    deferred.bind({ journal, fence: 1, publish: () => {} })
    const sink = providerTimelineSink(deferred.sink)
    if (!sink) {
      throw new Error('missing production transition sink')
    }
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0)
    const windows = new Set<() => void>()
    const assembler = createProviderTimelineAssembler({
      sink,
      sessionId: 'stream',
      agent: 'grok',
      generation: 'g1',
      namespace: 'p1',
      schedule: (run) => {
        windows.add(run)
        return () => windows.delete(run)
      }
    })
    const flush = async () => {
      const due = [...windows]
      windows.clear()
      due.forEach((run) => run())
      await deferred.drained()
    }
    const levels = commitLevels()
    const extraction = vi.spyOn(attachmentReferences, 'agentSessionAttachmentReferences')
    const acquired = vi.spyOn(JournalGoalAttachmentInverse.prototype, 'acquired')
    const delta = () =>
      assembler.apply({
        type: 'text.delta',
        item: { id: 'reply' },
        channel: 'assistant',
        text: 'hello '
      })
    try {
      delta()
      await flush()
      expect(levels).toEqual([2])
      levels.length = 0
      for (let n = 0; n < count; n++) {
        clock.mockReturnValue((n + 1) * 400)
        expect(delta().admission).toEqual({ accepted: true })
        await flush()
      }
      expect(levels).toEqual(Array(count).fill(1))
      expect(extraction).not.toHaveBeenCalled()
      expect(acquired).not.toHaveBeenCalled()
      expect(journal.snapshot().items).toHaveLength(1)
      expect(journal.snapshot().items[0]?.body).toEqual(
        text('assistant', 'hello '.repeat(count + 1))
      )
      expect(journalPragmaNumber(openTestJournalHostDatabase(fixture.root).db, 'synchronous')).toBe(
        2
      )
      process.stdout.write(
        `pr34654-stream-contract ${JSON.stringify({ count, levels, extractions: extraction.mock.calls.length, acquired: acquired.mock.calls.length })}\n`
      )
      levels.length = 0
      assembler.apply({ type: 'turn.open', turn: 'turn', at: 1 })
      assembler.apply({ type: 'turn.end', turn: 'turn', state: 'completed', at: 2 })
      await flush()
      expect(levels.length).toBeGreaterThan(0)
      expect(levels.every((level) => level === 2)).toBe(true)
      levels.length = 0
      const input = await uploadedInput()
      await journal.appendClaimingAttachments(
        { provider: 'orca', clientMessageId: 'goal' },
        { ...input.body, sentAs: 'goal' },
        { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
      expect(levels).toEqual([2])
      expect(acquired).toHaveBeenCalledTimes(1)
    } finally {
      assembler.dispose()
      deferred.close()
    }
  }
)

it('retains admitted full snapshots and replays the final body with its original position and annotations', async () => {
  const database = openTestJournalHostDatabase(fixture.root)
  const options = {
    database,
    identity: {
      sessionId: 'retention',
      workspaceId: 'workspace',
      hostId: 'host',
      agent: 'codex' as const,
      providerHandle: null
    }
  }
  const journal = await openAgentSessionJournal(options)
  const identity = { provider: 'codex' as const, threadId: 'thread', turnId: 'turn', ordinal: 1 }
  const savedItems = () =>
    database.db
      .prepare("SELECT value_json FROM journal_outcomes WHERE field = 'items' ORDER BY seq")
      .all()
      .map((row) => JSON.parse(String(row.value_json)))
  let original = ''
  for (let index = 1; index <= 100; index += 1) {
    await journal.appendItem(identity, text('assistant', 'x'.repeat(index * 4096)), {
      fence: 1,
      ownerFence: 1,
      executionOwner: 1,
      observedAt: index,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE,
      agentId: 'child',
      providerParentRef: 'parent'
    })
    if (index === 1) {
      original = JSON.stringify(savedItems()[0])
    }
  }
  const final = text('assistant', `${'x'.repeat(100 * 4096)} final`)
  await journal.appendItem(identity, final, { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE })
  const snapshot = journal.snapshot().items
  const saved = savedItems()
  expect(saved[0]).toEqual(JSON.parse(original))
  const storedBytes = saved.reduce(
    (bytes, item) => bytes + Buffer.byteLength(JSON.stringify(item)),
    0
  )
  expect(saved).toHaveLength(101)
  expect(saved.flatMap((item) => item.body.blocks)).toEqual([
    ...Array.from({ length: 100 }, (_, index) => ({
      type: 'text',
      text: 'x'.repeat((index + 1) * 4096)
    })),
    ...final.blocks
  ])
  expect(storedBytes).toBeGreaterThan(
    Buffer.byteLength(JSON.stringify(final)) + (4096 * 100 * 101) / 2
  )
  expect(snapshot[0]).toMatchObject({
    sequence: 2,
    observedAt: 1,
    turnScope: AGENT_JOURNAL_THREAD_SCOPE,
    agentId: 'child',
    providerParentRef: 'parent',
    body: final
  })
  await journal.close()
  const reopened = await openAgentSessionJournal(options)
  expect(reopened.snapshot().items).toEqual(snapshot)
  await reopened.close()
})

it.each([10, 100])(
  'commits %i timer-delivered plan-status checkpoints at FULL, skipping not-due arrivals before assembly',
  async (count) => {
    const options = {
      database: openTestJournalHostDatabase(fixture.root),
      identity: {
        sessionId: 'plan-cadence',
        workspaceId: 'folder',
        hostId: 'local',
        agent: 'codex' as const,
        providerHandle: null
      }
    }
    const journal = await openAgentSessionJournal(options)
    const levels = commitLevels()
    const publish = vi.fn()
    const deferred = createDeferredStructuredAgentSessionEventSink(
      testEventSinkLogging('plan-cadence')
    )
    deferred.bind({ journal, fence: 1, publish })
    const translator = createCodexJournalTranslator({
      sink: deferred.sink,
      bindPromptItemId: () => {}
    })
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] })
    vi.setSystemTime(500000)
    const notify = (method: string, params: unknown) =>
      translator.handle({
        type: 'notification',
        sessionId: 'plan-cadence',
        threadId: 'thread',
        method,
        params
      })
    const prefix = 'P'.repeat(100)
    const committedRows: JournalRow[] = []
    journal.observeCommits((rows) => committedRows.push(...(rows ?? [])))
    const tick = async (ms: number) => {
      vi.advanceTimersByTime(ms)
      await deferred.drained()
    }
    let expected = prefix
    try {
      notify('item/started', { item: { type: 'plan', id: 'plan', text: '' } })
      expect(notify('item/plan/delta', { itemId: 'plan', delta: '' })).toEqual({ accepted: true })
      await tick(60)
      expect(levels).toEqual([])
      expect(notify('item/plan/delta', { itemId: 'plan', delta: expected })).toEqual({
        accepted: true
      })
      await tick(59)
      expect(levels).toEqual([])
      await tick(1)
      const first = journal.snapshot().items[0]
      const snapshots = [prefix]
      const join = Array.prototype.join
      let assemblies = 0
      const observer = vi.spyOn(Array.prototype, 'join').mockImplementation(function (
        this: string[],
        separator
      ) {
        if (this[0] === prefix) {
          assemblies++
        }
        return join.call(this, separator)
      })
      try {
        for (let i = 0; i < count; i++) {
          expect(notify('item/plan/delta', { itemId: 'plan', delta: 'x' })).toEqual({
            accepted: true
          })
          await tick(60)
          expect(assemblies).toBe(0)
          expect(levels).toHaveLength(i + 1)
          expect(publish).toHaveBeenCalledTimes(i + 1)
          expect(vi.getTimerCount()).toBe(1)
          vi.setSystemTime(100 - i)
          await tick(339)
          expect(assemblies).toBe(0)
          await tick(1)
          expected += 'x'
          snapshots.push(expected)
          expect(journal.snapshot().items[0].body).toEqual({
            kind: 'status',
            text: expected,
            presentation: 'plan-document'
          })
          expect(assemblies).toBeGreaterThan(0)
          assemblies = 0
        }
        expect(notify('item/plan/delta', { itemId: 'plan', delta: ' tail' })).toEqual({
          accepted: true
        })
        await tick(60)
        expect(assemblies).toBe(0)
        expect(levels).toHaveLength(count + 1)
        translator.flush()
        await deferred.drained()
        expected += ' tail'
        snapshots.push(expected)
      } finally {
        observer.mockRestore()
      }
      expect(levels).toEqual(Array(count + 2).fill(2))
      expect(publish).toHaveBeenCalledTimes(count + 2)
      const rows = committedRows.filter((row) => row.kind === 'item')
      expect(rows.map((row) => row.body)).toEqual(
        snapshots.map((value) => ({ kind: 'status', text: value, presentation: 'plan-document' }))
      )
      const bodyBytes = rows.reduce(
        (sum, row) => sum + Buffer.byteLength(JSON.stringify(row.body)),
        0
      )
      const envelopeBytes = rows.reduce(
        (sum, row) => sum + Buffer.byteLength(JSON.stringify(row)),
        0
      )
      expect(bodyBytes).toBe(
        snapshots.reduce(
          (sum, value) =>
            sum +
            Buffer.byteLength(
              JSON.stringify({ kind: 'status', text: value, presentation: 'plan-document' })
            ),
          0
        )
      )
      expect(envelopeBytes).toBeGreaterThan(bodyBytes)
      console.info(
        'plan-cadence-metrics',
        JSON.stringify({
          count,
          acceptedDeltas: count + 3,
          ordinarySaves: count + 1,
          skippedWindows: count + 1,
          forcedSaves: 1,
          publications: publish.mock.calls.length,
          fullCommits: levels.length,
          insertedBodyBytes: bodyBytes,
          insertedEnvelopeBytes: envelopeBytes,
          retainedLogicalItemBytes: openTestJournalHostDatabase(fixture.root)
            .db.prepare(
              "SELECT COALESCE(SUM(length(CAST(value_json AS BLOB))), 0) AS bytes FROM journal_outcomes WHERE field = 'items'"
            )
            .get()?.bytes
        })
      )
      expect(journal.snapshot().items[0]).toMatchObject({
        sequence: first.sequence,
        observedAt: first.observedAt,
        turnScope: first.turnScope
      })
      translator.dispose()
      await journal.close()
      const reopened = await openAgentSessionJournal(options)
      expect(reopened.snapshot().items[0]).toMatchObject({
        sequence: first.sequence,
        observedAt: first.observedAt,
        turnScope: first.turnScope,
        body: { text: expected }
      })
    } finally {
      translator.dispose()
      vi.useRealTimers()
    }
  }
)
