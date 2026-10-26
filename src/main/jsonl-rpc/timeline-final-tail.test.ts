import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../shared/agent-session-journal-types'
import {
  closeProviderTimelineRigs,
  openProviderTimelineRig,
  pendingApproval,
  SESSION,
  GENERATION,
  NAMESPACE
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { providerTimelineSink } from '../native-chat/agent-session-timeline/provider-timeline-plan'
import { createDeferredStructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { evictStructuredAgentSession } from '../native-chat/agent-session-wire/structured-agent-session-eviction'
import { testEventSinkLogging } from '../native-chat/agent-session-wire/structured-agent-session-logger-test-support'
import { JsonlRpcTimelineLane } from './timeline-lane'

const cleanups: (() => void)[] = []
afterEach(async () => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  vi.useRealTimers()
  await closeProviderTimelineRigs()
})

describe('Pi final tail before host eviction', () => {
  it('admits text and settlements before the exit barrier while ordinary and lifecycle queues are full', async () => {
    const { journal } = await openProviderTimelineRig({ agent: 'pi' })
    const logging = testEventSinkLogging(SESSION)
    const deferred = createDeferredStructuredAgentSessionEventSink({
      ...logging,
      watermarks: { maxQueuedOperations: 1, maxLifecycleQueuedOperations: 1 }
    })
    deferred.bind({ journal, fence: 1, publish: () => {} })
    const sink = providerTimelineSink(deferred.sink)
    if (!sink) {
      throw new Error('the sink must provide transitions')
    }
    const onFailed = vi.fn()
    const lane = new JsonlRpcTimelineLane({
      sink,
      sessionId: SESSION,
      agent: 'pi',
      generation: GENERATION,
      namespace: NAMESPACE,
      pauseReading: vi.fn(),
      resumeReading: vi.fn(),
      onInputAccepted: vi.fn(),
      onFailed
    })
    cleanups.push(
      () => lane.dispose(),
      () => deferred.close()
    )
    for (const event of [
      { type: 'turn.open', turn: 'run:1', at: 1 },
      { type: 'request.open', request: 'confirm:1', body: pendingApproval },
      {
        type: 'item.open',
        item: 'tool:1',
        body: { kind: 'tool-call', name: 'bash', input: {}, state: 'running' }
      }
    ] as const) {
      lane.apply([event])
      await deferred.drained()
      lane.retry()
    }
    const gate = Promise.withResolvers<void>()
    cleanups.push(() => gate.resolve())
    const append = (recordId: string, lifecycle = false) =>
      deferred.sink.tryAppendItem?.(
        { provider: 'legacy', agent: 'pi', sessionId: SESSION, recordId },
        { kind: 'status', tone: 'info', text: recordId },
        { lifecycle, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
    // The nested write joins behind this held read; later writes stay in the real journal queue.
    const blocked = journal.readInOrder(() => {
      expect(append('ordinary-full')).toEqual({ accepted: true })
      return gate.promise
    })
    expect(append('lifecycle-full', true)).toEqual({ accepted: true })
    expect(append('ordinary-refused')).toEqual({ accepted: false, reason: 'backpressure' })
    expect(append('lifecycle-refused', true)).toEqual({ accepted: false, reason: 'backpressure' })
    const before = journal.snapshot().items.length
    vi.useFakeTimers()
    const reply = `Final reply${'r'.repeat(2 * 1024 * 1024)}`
    const status = `Final status${'s'.repeat(17 * 1024 * 1024)}`
    lane.apply([
      { type: 'text.delta', item: { id: 'reply' }, channel: 'assistant', text: reply },
      {
        type: 'item.update',
        item: 'tail',
        body: { kind: 'status', tone: 'info', text: status }
      }
    ])
    lane.finalize({ type: 'session.ended', verdict: { state: 'interrupted', completedAt: 2 } })
    lane.apply([
      {
        type: 'item.close',
        item: 'after-seal',
        body: { kind: 'status', tone: 'info', text: 'must not land' }
      }
    ])
    let landed = false
    const barrier = deferred.drained().then((result) => {
      landed = true
      return result
    })
    await vi.advanceTimersByTimeAsync(2_501)
    expect(journal.snapshot().items).toHaveLength(before)
    expect(landed).toBe(false)
    expect(onFailed).not.toHaveBeenCalled()
    gate.resolve()
    await blocked
    await expect(barrier).resolves.toEqual({ ok: true })
    const acknowledgeRelease = vi.fn(() => lane.dispose())
    await evictStructuredAgentSession({
      sessionId: SESSION,
      eventSink: deferred,
      logger: logging.logger,
      acknowledgeRelease,
      discardSink: vi.fn()
    })
    expect(acknowledgeRelease).toHaveBeenCalledOnce()
    expect(
      journal
        .snapshot()
        .items.some((item) => item.body.kind === 'status' && item.body.text === 'must not land')
    ).toBe(false)
    expect(journal.snapshot().items.map((item) => item.body)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'message',
          role: 'assistant',
          blocks: [{ type: 'text', text: reply }]
        }),
        expect.objectContaining({ kind: 'status', text: status }),
        expect.objectContaining({
          kind: 'approval',
          resolution: expect.objectContaining({ state: 'cancelled' })
        }),
        expect.objectContaining({ kind: 'tool-call', state: 'failed' })
      ])
    )
  })

  it('keeps the final transfer operation-count limit', async () => {
    const failures: unknown[] = []
    const deferred = createDeferredStructuredAgentSessionEventSink({
      ...testEventSinkLogging(SESSION),
      onFailed: (error) => failures.push(error)
    })
    cleanups.push(() => deferred.close())
    for (let index = 0; index <= 512; index += 1) {
      expect(
        deferred.sink.tryAppendTransition?.({
          finalTail: true,
          lifecycle: true,
          publish: false,
          steps: [
            {
              kind: 'settlement',
              settlementId: `tail:${index}`,
              reservedBytes: 1,
              resolve: () => []
            }
          ]
        })
      ).toEqual(index < 512 ? { accepted: true } : { accepted: false, reason: 'failed' })
    }
    expect(failures).toEqual([
      expect.objectContaining({
        message: 'structured agent-session final tail exceeded its reserved capacity'
      })
    ])
    await expect(deferred.drained()).resolves.toMatchObject({ ok: false })
  })
})
