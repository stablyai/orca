import { expect, it, vi } from 'vitest'
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
  text,
  uploadedInput
} from './journal-streamed-revision-contract-test-fixture'

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
    text('assistant', 'Goal reached')
  ]) {
    await journal.appendItem(
      { provider: 'codex', threadId: 'thread', turnId: 'turn', ordinal: 1 },
      body,
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
  }
  expect(levels).toEqual([2, 1, 2, 2, 2, 2])
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
