import { describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  createDeferredStructuredAgentSessionEventSink,
  type StructuredAgentSessionEventTarget
} from './structured-agent-session-event-sink'
import { StructuredAgentSessionHostRuntimeState } from './structured-agent-session-host-runtime-state'

const BODY: AgentJournalItemBody = {
  kind: 'message',
  role: 'assistant',
  blocks: [{ type: 'text', text: 'hi' }]
}

function identity(ordinal: number): AgentJournalItemIdentity {
  return { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal }
}

type Recorded = { call: string; fence?: number; ordinal?: number; settlementId?: string }

function target(
  fence: number,
  log: Recorded[],
  failOn?: number
): StructuredAgentSessionEventTarget {
  const journal = {
    appendItem: vi.fn(async (id: AgentJournalItemIdentity, _body: AgentJournalItemBody) => {
      const ordinal = id.provider === 'codex' ? id.ordinal : -1
      if (ordinal === failOn) {
        throw new Error(`refused ${ordinal}`)
      }
      log.push({ call: 'appendItem', fence, ordinal })
      return { cursor: { epoch: 'e', sequence: ordinal } }
    }),
    appendTombstone: vi.fn(async (id: AgentJournalItemIdentity) => {
      log.push({
        call: 'appendTombstone',
        fence,
        ordinal: id.provider === 'codex' ? id.ordinal : -1
      })
      return { epoch: 'e', sequence: 0 }
    }),
    appendLifecycleBatch: vi.fn(async (input: { settlementId: string }) => {
      log.push({ call: 'appendLifecycleBatch', fence, settlementId: input.settlementId })
      return { epoch: 'e', sequence: 0 }
    })
  } as unknown as AgentSessionJournal
  return { journal, fence, publish: () => log.push({ call: 'publish', fence }) }
}

describe('deferred structured agent-session event sink', () => {
  it('buffers writes made before the journal exists and drains them in arrival order', async () => {
    const log: Recorded[] = []
    const deferred = createDeferredStructuredAgentSessionEventSink()

    deferred.sink.appendItem(identity(0), BODY)
    deferred.sink.appendItem(identity(1), BODY)
    deferred.sink.publish()
    expect(log).toEqual([])

    deferred.bind(target(7, log))
    await deferred.drained()

    expect(log).toEqual([
      { call: 'appendItem', fence: 7, ordinal: 0 },
      { call: 'appendItem', fence: 7, ordinal: 1 },
      { call: 'publish', fence: 7 }
    ])
  })

  it('writes at the fence bound at submission time, so a rebind cannot backdate a write', async () => {
    const log: Recorded[] = []
    const deferred = createDeferredStructuredAgentSessionEventSink()
    deferred.bind(target(1, log))

    deferred.sink.appendItem(identity(0), BODY)
    // The re-attach that raised the fence.
    deferred.bind(target(2, log))
    deferred.sink.appendItem(identity(1), BODY)
    await deferred.drained()

    expect(log).toEqual([
      { call: 'appendItem', fence: 1, ordinal: 0 },
      { call: 'appendItem', fence: 2, ordinal: 1 }
    ])
  })

  it('buffers replacement-acquisition events while unbound', async () => {
    const log: Recorded[] = []
    const deferred = createDeferredStructuredAgentSessionEventSink()
    deferred.bind(target(1, log))
    deferred.unbind()

    deferred.sink.appendItem(identity(0), BODY)
    expect(log).toEqual([])
    deferred.bind(target(2, log))
    await deferred.drained()

    expect(log).toEqual([{ call: 'appendItem', fence: 2, ordinal: 0 }])
  })

  it('drops buffered and later writes once closed, and refuses to rebind', async () => {
    const log: Recorded[] = []
    const deferred = createDeferredStructuredAgentSessionEventSink()

    deferred.sink.appendItem(identity(0), BODY)
    deferred.close()
    deferred.bind(target(3, log))
    deferred.sink.appendItem(identity(1), BODY)
    await deferred.drained()

    expect(log).toEqual([])
  })

  it('reports one refused append, fails the barrier, and stops later writes', async () => {
    const log: Recorded[] = []
    const errors: unknown[] = []
    const readingControl = { pauseReading: vi.fn(), resumeReading: vi.fn() }
    const deferred = createDeferredStructuredAgentSessionEventSink({
      onError: (error) => errors.push(error),
      readingControl
    })
    deferred.bind(target(4, log, 0))

    deferred.sink.appendItem(identity(0), BODY)
    deferred.sink.appendTombstone(identity(1))
    const barrier = await deferred.drained()

    expect(errors).toHaveLength(1)
    expect((errors[0] as Error).message).toBe('refused 0')
    expect(barrier).toMatchObject({ ok: false })
    expect(log).toEqual([])
    expect(deferred.state()).toMatchObject({
      failed: true,
      backpressured: true,
      queuedBytes: 0,
      queuedOperations: 0
    })
    expect(readingControl.pauseReading).toHaveBeenCalledOnce()
    expect(readingControl.resumeReading).not.toHaveBeenCalled()
  })

  it('replaces a failed cached sink before recovery drain', async () => {
    const runtime = new StructuredAgentSessionHostRuntimeState({ store: {} } as never)
    const failed = runtime.eventSinkFor('session-1')
    failed.bind(target(1, [], 0))
    failed.sink.appendItem(identity(0), BODY)
    await expect(failed.drained()).resolves.toMatchObject({ ok: false })

    const recovered = runtime.eventSinkFor('session-1')
    expect(recovered).not.toBe(failed)
    const log: Recorded[] = []
    recovered.bind(target(2, log))
    recovered.sink.appendItem(identity(1), BODY)
    await expect(recovered.drained()).resolves.toEqual({ ok: true })
    expect(log).toEqual([{ call: 'appendItem', fence: 2, ordinal: 1 }])
  })

  it('exposes operation watermarks and resumes below the low watermark', async () => {
    const log: Recorded[] = []
    const changes: boolean[] = []
    const readingControl = { pauseReading: vi.fn(), resumeReading: vi.fn() }
    const deferred = createDeferredStructuredAgentSessionEventSink({
      watermarks: {
        maxQueuedBytes: 1_000_000,
        lowQueuedBytes: 0,
        maxQueuedOperations: 2,
        lowQueuedOperations: 0
      },
      readingControl,
      onBackpressureChange: (paused) => changes.push(paused)
    })

    expect(deferred.sink.tryAppendItem?.(identity(0), BODY)).toEqual({ accepted: true })
    expect(deferred.sink.tryAppendItem?.(identity(1), BODY)).toEqual({ accepted: true })
    expect(deferred.sink.tryAppendItem?.(identity(2), BODY)).toEqual({
      accepted: false,
      reason: 'backpressure'
    })
    expect(deferred.state()).toMatchObject({ backpressured: true, queuedOperations: 2 })

    deferred.bind(target(5, log))
    await deferred.drained()

    expect(changes).toEqual([true, false])
    expect(readingControl.pauseReading).toHaveBeenCalledOnce()
    expect(readingControl.resumeReading).toHaveBeenCalledOnce()
    expect(log).toHaveLength(2)
  })

  it('pauses provider reading at the soft byte watermark before rejecting writes', async () => {
    const log: Recorded[] = []
    const changes: boolean[] = []
    const readingControl = { pauseReading: vi.fn(), resumeReading: vi.fn() }
    const deferred = createDeferredStructuredAgentSessionEventSink({
      watermarks: {
        pauseQueuedBytes: 1,
        maxQueuedBytes: 1_000_000,
        lowQueuedBytes: 0,
        pauseQueuedOperations: 1_000,
        maxQueuedOperations: 1_000,
        lowQueuedOperations: 0
      },
      readingControl,
      onBackpressureChange: (paused) => changes.push(paused)
    })

    expect(deferred.sink.tryAppendItem?.(identity(0), BODY)).toEqual({ accepted: true })
    expect(deferred.state()).toMatchObject({ backpressured: true, queuedOperations: 1 })
    expect(readingControl.pauseReading).toHaveBeenCalledOnce()

    deferred.bind(target(8, log))
    await deferred.drained()

    expect(changes).toEqual([true, false])
    expect(readingControl.resumeReading).toHaveBeenCalledOnce()
    expect(log).toEqual([{ call: 'appendItem', fence: 8, ordinal: 0 }])
  })

  it('backpressures lifecycle publication at the hard operation watermark', async () => {
    const log: Recorded[] = []
    const errors: unknown[] = []
    const deferred = createDeferredStructuredAgentSessionEventSink({
      onError: (error) => errors.push(error),
      watermarks: {
        pauseQueuedBytes: 1,
        maxQueuedBytes: 1,
        lowQueuedBytes: 0,
        pauseQueuedOperations: 1,
        maxQueuedOperations: 0,
        lowQueuedOperations: 0,
        maxLifecycleQueuedOperations: 1
      }
    })

    deferred.sink.appendLifecycleBatch?.(
      'settlement-1',
      [{ kind: 'item', identity: identity(0), body: BODY }],
      { lifecycle: true }
    )
    expect(deferred.sink.tryPublish?.({ lifecycle: true })).toEqual({
      accepted: false,
      reason: 'backpressure'
    })
    expect(deferred.state()).toMatchObject({ queuedOperations: 1, backpressured: true })
    expect(errors).toHaveLength(0)

    deferred.bind(target(8, log))
    await expect(deferred.lifecycleBarrier()).resolves.toEqual({ ok: true })

    expect(log).toEqual([{ call: 'appendLifecycleBatch', fence: 8, settlementId: 'settlement-1' }])
  })

  it('ignores stale reading-control cleanup after a newer provider stream binds', async () => {
    const log: Recorded[] = []
    const firstControl = { pauseReading: vi.fn(), resumeReading: vi.fn() }
    const secondControl = { pauseReading: vi.fn(), resumeReading: vi.fn() }
    const deferred = createDeferredStructuredAgentSessionEventSink({
      watermarks: {
        pauseQueuedBytes: 1,
        maxQueuedBytes: 1_000_000,
        lowQueuedBytes: 0,
        pauseQueuedOperations: 1_000,
        maxQueuedOperations: 1_000,
        lowQueuedOperations: 0
      }
    })
    const releaseFirst = deferred.sink.bindReadingControl?.(firstControl)

    expect(deferred.sink.tryAppendItem?.(identity(0), BODY)).toEqual({ accepted: true })
    expect(firstControl.pauseReading).toHaveBeenCalledOnce()

    const releaseSecond = deferred.sink.bindReadingControl?.(secondControl)
    expect(secondControl.pauseReading).toHaveBeenCalledOnce()
    releaseFirst?.()

    deferred.bind(target(9, log))
    await deferred.drained()

    expect(firstControl.resumeReading).not.toHaveBeenCalled()
    expect(secondControl.resumeReading).toHaveBeenCalledOnce()
    expect(log).toEqual([{ call: 'appendItem', fence: 9, ordinal: 0 }])
    releaseSecond?.()
  })

  it('replaces a queued same-item checkpoint before any blob is created', async () => {
    const log: Recorded[] = []
    const deferred = createDeferredStructuredAgentSessionEventSink()
    const options = { coalescingKey: 'checkpoint:item-1' }

    deferred.sink.appendItem(identity(0), BODY, [], options)
    deferred.sink.appendItem(identity(1), BODY, [], options)
    expect(deferred.state().queuedOperations).toBe(1)

    deferred.bind(target(6, log))
    await deferred.drained()
    expect(log).toEqual([{ call: 'appendItem', fence: 6, ordinal: 1 }])
  })

  it('keeps a replacement checkpoint after distinct intervening operations', async () => {
    const log: Recorded[] = []
    const deferred = createDeferredStructuredAgentSessionEventSink()
    const options = { coalescingKey: 'checkpoint:item-1' }

    deferred.sink.appendItem(identity(0), BODY, [], options)
    deferred.sink.appendItem(identity(1), BODY)
    deferred.sink.appendItem(identity(2), BODY, [], options)
    deferred.bind(target(6, log))
    await deferred.drained()

    expect(log).toEqual([
      { call: 'appendItem', fence: 6, ordinal: 1 },
      { call: 'appendItem', fence: 6, ordinal: 2 }
    ])
  })
})
