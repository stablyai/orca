import {
  openTestJournalHostDatabase,
  closeTestJournalHostDatabase
} from '../native-chat/agent-session-journal/journal-host-database-test-support'
import {
  checkpointJournalRig,
  closeCheckpointTestJournals
} from '../claude/claude-checkpoint-test-support'
import { providerTimelineSink } from '../native-chat/agent-session-timeline/provider-timeline-plan'
import { messageText } from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  closeProviderTimelineRigs,
  openProviderTimelineRig,
  refusingSink,
  SESSION,
  GENERATION,
  NAMESPACE
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { JsonlRpcTimelineLane } from './timeline-lane'

const lanes: JsonlRpcTimelineLane[] = []
afterEach(async () => {
  for (const lane of lanes.splice(0)) {
    lane.dispose()
  }
  vi.useRealTimers()
  await closeProviderTimelineRigs()
  await closeCheckpointTestJournals()
})

async function rig() {
  const journal = await openProviderTimelineRig({ agent: 'pi' })
  let blocked = true
  const pauseReading = vi.fn(),
    resumeReading = vi.fn(),
    onInputAccepted = vi.fn(),
    onFailed = vi.fn()
  const lane = new JsonlRpcTimelineLane({
    sink: refusingSink(journal.sink, () => blocked),
    sessionId: SESSION,
    agent: 'pi',
    generation: GENERATION,
    namespace: NAMESPACE,
    pauseReading,
    resumeReading,
    onInputAccepted,
    onFailed
  })
  lanes.push(lane)
  return {
    journal,
    lane,
    pauseReading,
    resumeReading,
    onInputAccepted,
    onFailed,
    unblock: () => {
      blocked = false
    }
  }
}

describe('JSON-lines timeline admission', () => {
  it('admits the final tail with the host settlement budget when ordinary writes are full', async () => {
    const journal = await openProviderTimelineRig({ agent: 'pi' })
    const lane = new JsonlRpcTimelineLane({
      sink: {
        ...journal.sink,
        tryAppendTransition: (transition) =>
          transition.lifecycle
            ? journal.sink.tryAppendTransition(transition)
            : { accepted: false, reason: 'backpressure' }
      },
      sessionId: SESSION,
      agent: 'pi',
      generation: GENERATION,
      namespace: NAMESPACE,
      pauseReading: vi.fn(),
      resumeReading: vi.fn(),
      onInputAccepted: vi.fn(),
      onFailed: vi.fn()
    })
    lanes.push(lane)
    lane.apply([
      {
        type: 'item.update',
        item: 'final',
        body: { kind: 'status', tone: 'info', text: 'Final tail' }
      }
    ])
    expect(await journal.rows()).toEqual([])
    lane.finalize()
    await lane.drained()
    expect(await journal.rows()).toEqual([
      expect.objectContaining({ body: { kind: 'status', tone: 'info', text: 'Final tail' } })
    ])
  })

  it('holds an entire parsed batch and accepts input only after journal admission', async () => {
    const test = await rig()
    test.lane.apply([
      { type: 'turn.open', turn: 'run:1', at: 1 },
      { type: 'input.accepted', clientMessageId: 'message:1', requestedAt: 1 },
      { type: 'turn.end', at: 2, state: 'completed', outcome: 'success' }
    ])
    expect(test.pauseReading).toHaveBeenCalled()
    expect(test.onInputAccepted).not.toHaveBeenCalled()
    expect(await test.journal.turns()).toEqual([])
    test.unblock()
    test.lane.retry()
    await test.lane.drained()
    expect(test.onInputAccepted).toHaveBeenCalledExactlyOnceWith('message:1')
    expect(test.resumeReading).toHaveBeenCalled()
    expect(await test.journal.turns()).toHaveLength(1)
    expect((await test.journal.turns())[0]).toMatchObject({
      state: 'completed',
      outcome: 'success'
    })
  })

  it('retries paused input and clears its timer after draining', async () => {
    const test = await rig()
    vi.useFakeTimers()
    test.lane.apply([{ type: 'turn.open', turn: 'run:1', at: 1 }])
    test.unblock()
    await vi.advanceTimersByTimeAsync(250)
    await test.lane.drained()
    expect(test.lane.openTurnId).not.toBeNull()
    // Close the journal's projection repair timer; leave the lane alive to detect retry leaks.
    await test.journal.journal.close()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds data already parsed in a batch after the reader pauses', async () => {
    const test = await rig()
    test.lane.apply(
      Array.from({ length: 257 }, (_, index) => ({
        type: 'item.close',
        item: `item:${index}`,
        body: { kind: 'status', tone: 'info', text: 'held' }
      }))
    )
    expect(test.onFailed).toHaveBeenCalledExactlyOnceWith('Agent timeline queue capacity exceeded')
    await expect(test.lane.drained()).resolves.toBeUndefined()
    expect(test.onInputAccepted).not.toHaveBeenCalled()
  })

  it('releases drain and turn waiters when a failed lane is disposed', async () => {
    const test = await rig()
    test.unblock()
    test.lane.apply([{ type: 'turn.open', turn: 'run:1', at: 1 }])
    const turn = test.lane.openTurnId
    expect(turn).not.toBeNull()
    const waiting = test.lane.whenTurnLeaves(turn!)
    test.lane.dispose()
    await expect(waiting).resolves.toBeUndefined()
  })
})

it.each([
  { boundary: 'drain', delay: 40 },
  { boundary: 'closed', delay: 40 },
  { boundary: 'failed', delay: 40 },
  { boundary: 'drain', delay: 440 }
] as const)(
  'settles the real refused metadata release and held final via $boundary after $delay ms without pulling another frame',
  async ({ boundary, delay }) => {
    const r = await checkpointJournalRig({
      watermarks: {
        maxQueuedOperations: 2,
        maxLifecycleQueuedOperations: 2,
        lowQueuedOperations: 0,
        lowQueuedBytes: 0
      }
    })
    r.translator.dispose()
    const sink = providerTimelineSink(r.deferred.sink)!
    const append = vi.fn(sink.tryAppendTransition)
    sink.tryAppendTransition = append
    const pauseReading = vi.fn(),
      resumeReading = vi.fn(),
      onFailed = vi.fn()
    const lane = new JsonlRpcTimelineLane({
      sink,
      sessionId: 'recovery',
      agent: 'pi',
      generation: 'g',
      namespace: 'n',
      pauseReading,
      resumeReading,
      onFailed,
      onInputAccepted: vi.fn()
    })
    lanes.push(lane)
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] })
    lane.apply([{ type: 'turn.open', turn: 't', at: 1 }])
    await r.deferred.drained()
    const leaving = lane.whenTurnLeaves(lane.openTurnId!)
    const delta = { type: 'text.delta', item: { stream: 'reply' }, channel: 'assistant' } as const
    lane.apply([{ ...delta, text: 'P'.repeat(100) }])
    await vi.advanceTimersByTimeAsync(60)
    await r.deferred.drained()
    const first = r.journal.snapshot().items.find((item) => item.body.kind === 'message')!
    await vi.advanceTimersByTimeAsync(delay)
    lane.apply([{ ...delta, text: 'T'.repeat(40) }])
    const gate = Promise.withResolvers<void>()
    await r.journal.readInOrder(() => {
      void r.journal.readInOrder(() => gate.promise)
    })
    for (const uuid of ['block1', 'block2']) {
      expect(
        r.deferred.sink.tryAppendItem?.(
          { provider: 'claude', sessionId: 'block', uuid },
          { kind: 'status', text: uuid },
          { turnScope: { kind: 'thread' }, lifecycle: true }
        )
      ).toEqual({ accepted: true })
    }
    try {
      lane.apply([
        { type: 'context.usage', usage: { window: { tokens: 1000, capturedAt: 100 } } },
        { ...delta, text: 'U' },
        { type: 'text.close', item: delta.item },
        { type: 'turn.end', state: 'completed', at: 500 }
      ])
      expect(pauseReading).toHaveBeenCalled()
      expect(append.mock.results.at(-1)?.value).toEqual({ accepted: false, reason: 'backpressure' })
      expect(append.mock.calls.at(-1)?.[0]).toMatchObject({
        lifecycle: true,
        steps: [
          expect.objectContaining({ kind: 'item' }),
          expect.objectContaining({ kind: 'item' })
        ]
      })
      await vi.advanceTimersByTimeAsync(60)
      expect(messageText(r.journal.item(first.itemId)?.body)).toBe('P'.repeat(100))
      expect(
        append.mock.calls.some(([transition], index) => {
          const result = append.mock.results[index]
          return (
            !transition.lifecycle &&
            result?.type === 'return' &&
            !result.value.accepted &&
            result.value.reason === 'backpressure'
          )
        })
      ).toBe(delay === 440)
      if (boundary === 'closed') {
        r.deferred.close()
      }
      if (boundary === 'failed') {
        // A real native write failure poisons the deferred sink before the retained head retries.
        const database = openTestJournalHostDatabase(r.root)
        database.db.exec(
          "CREATE TRIGGER reject_metadata BEFORE INSERT ON journal_outcomes BEGIN SELECT RAISE(ROLLBACK, 'metadata failure'); END"
        )
      }
    } finally {
      gate.resolve()
    }
    await r.deferred.drained()
    await vi.advanceTimersByTimeAsync(250)
    await lane.drained()
    await leaving
    await r.deferred.drained()
    if (boundary === 'drain') {
      expect(onFailed).not.toHaveBeenCalled()
      expect(resumeReading).toHaveBeenCalled()
      const messages = r.journal.snapshot().items.filter((item) => item.body.kind === 'message')
      expect(messages.map((item) => messageText(item.body))).toEqual([
        'P'.repeat(100) + 'T'.repeat(40),
        'U'
      ])
      expect(messages[0]).toMatchObject({
        ...first,
        revision: first.revision + 1,
        body: { blocks: [{ type: 'text', text: 'P'.repeat(100) + 'T'.repeat(40) }] }
      })
      const before = structuredClone(r.journal.snapshot().items)
      expect(vi.getTimerCount()).toBe(0)
      await r.journal.close()
      await closeTestJournalHostDatabase(r.root)
      const reopened = await r.reopen()
      expect(reopened.snapshot().items).toEqual(before)
    } else {
      expect(onFailed).toHaveBeenCalledExactlyOnceWith(boundary)
      expect(vi.getTimerCount()).toBe(0)
      expect(messageText(r.journal.item(first.itemId)?.body)).toBe('P'.repeat(100))
      const before = structuredClone(r.journal.snapshot().items)
      await r.journal.close()
      await closeTestJournalHostDatabase(r.root)
      expect((await r.reopen()).snapshot().items).toEqual(before)
    }
  }
)
