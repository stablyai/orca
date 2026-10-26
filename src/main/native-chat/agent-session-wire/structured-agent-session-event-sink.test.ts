import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { describe, expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionTurnActivity } from '../../../shared/agent-session-wire'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type {
  JournalItemAppendOptions,
  JournalLifecycleBatchInput
} from '../agent-session-journal/journal-store-contracts'
import {
  createDeferredStructuredAgentSessionEventSink,
  type StructuredAgentSessionEventTarget
} from './structured-agent-session-event-sink'
import { StructuredAgentSessionSinkQueue } from './structured-agent-session-event-sink-queue'
import { StructuredAgentSessionHostRuntimeState } from './structured-agent-session-host-runtime-state'
import { openAgentSessionJournal } from '../agent-session-journal/journal-store-factory'
import {
  closeTestJournalHostDatabase,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import { createCodexJournalTranslator } from '../../codex/codex-structured-journal-translation'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { testEventSinkLogging } from './structured-agent-session-logger-test-support'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'

const BODY: AgentJournalItemBody = {
  kind: 'message',
  role: 'assistant',
  blocks: [{ type: 'text', text: 'hi' }]
}

const JOURNAL_IDENTITY = {
  sessionId: 'session-1',
  workspaceId: 'workspace-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: codexProviderHandle('thread-1')
} as const

function identity(ordinal: number): AgentJournalItemIdentity {
  return { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal }
}

type Recorded = {
  call: string
  fence?: number
  ordinal?: number
  settlementId?: string
  activity?: AgentSessionTurnActivity | null
}

/** Capture actual append options separately so call-order tests cannot hide missing forwarded fields. */
const journalAppendOptions: Partial<JournalItemAppendOptions>[] = []

function target(
  fence: number,
  log: Recorded[],
  failOn?: number
): StructuredAgentSessionEventTarget {
  journalAppendOptions.length = 0
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a double for the handful of journal methods this sink calls; nothing else on it is ever reached.
  const journal = {
    appendItem: vi.fn(
      async (
        id: AgentJournalItemIdentity,
        _body: AgentJournalItemBody,
        options: JournalItemAppendOptions
      ) => {
        const ordinal = id.provider === 'codex' ? id.ordinal : -1
        if (ordinal === failOn) {
          throw new Error(`refused ${ordinal}`)
        }
        journalAppendOptions.push(options)
        log.push({ call: 'appendItem', fence, ordinal })
        return { cursor: { epoch: 'e', sequence: ordinal } }
      }
    ),
    appendTombstone: vi.fn(async (id: AgentJournalItemIdentity) => {
      log.push({
        call: 'appendTombstone',
        fence,
        ordinal: id.provider === 'codex' ? id.ordinal : -1
      })
      return { epoch: 'e', sequence: 0 }
    }),
    appendLifecycleBatch: vi.fn(async (input: JournalLifecycleBatchInput) => {
      // Lifecycle batches carry linkage per mutation, not on their row.
      journalAppendOptions.push({ fence: input.fence })
      log.push({ call: 'appendLifecycleBatch', fence, settlementId: input.settlementId })
      return { epoch: 'e', sequence: 0 }
    }),
    latestItemMatching: vi.fn(() => null),
    readInOrder: vi.fn(async <T>(read: () => T) => read()),
    appendResolvedItem: vi.fn(
      async (
        resolve: () => { identity: AgentJournalItemIdentity; body: AgentJournalItemBody } | null,
        options: JournalItemAppendOptions
      ) => {
        const resolved = resolve()
        return resolved === null
          ? null
          : journal.appendItem(resolved.identity, resolved.body, options)
      }
    )
  } as unknown as AgentSessionJournal
  return {
    journal,
    fence,
    publish: (activity) =>
      log.push({ call: 'publish', fence, ...(activity !== undefined ? { activity } : {}) })
  }
}

describe('deferred structured agent-session event sink', () => {
  it('bounds buffered key lookup and snapshot work while preserving coalescing and drop order', async () => {
    const measure = async (size: number) => {
      const runs = new WeakSet<object>()
      const maps = new WeakSet<object>()
      const counts = { keys: 0, snapshot: 0, scanned: 0 }
      const isOperation = (value: unknown): boolean =>
        typeof value === 'object' &&
        value !== null &&
        'run' in value &&
        typeof value.run === 'function' &&
        runs.has(value.run)
      const keyed = (key: unknown): boolean =>
        typeof key === 'string' && key.startsWith('buffer-cost:')
      const get = Map.prototype.get
      const set = Map.prototype.set
      const remove = Map.prototype.delete
      const values = Map.prototype.values
      const findIndex = Array.prototype.findIndex
      const spies = [
        vi.spyOn(Map.prototype, 'get').mockImplementation(function (
          this: Map<unknown, unknown>,
          key: unknown
        ) {
          if (keyed(key) || maps.has(this)) {
            maps.add(this)
            counts.keys += 1
          }
          return get.call(this, key)
        }),
        vi.spyOn(Map.prototype, 'set').mockImplementation(function (
          this: Map<unknown, unknown>,
          key: unknown,
          value: unknown
        ) {
          if (isOperation(value) || maps.has(this)) {
            maps.add(this)
            counts.keys += 1
          }
          return set.call(this, key, value)
        }),
        vi.spyOn(Map.prototype, 'delete').mockImplementation(function (
          this: Map<unknown, unknown>,
          key: unknown
        ) {
          if (keyed(key) || maps.has(this)) {
            counts.keys += 1
          }
          return remove.call(this, key)
        }),
        vi.spyOn(Map.prototype, 'values').mockImplementation(function (
          this: Map<unknown, unknown>
        ) {
          if (maps.has(this)) {
            counts.snapshot += this.size
          }
          return values.call(this)
        }),
        vi.spyOn(Array.prototype, 'findIndex').mockImplementation(function (
          this: unknown[],
          predicate,
          thisArg
        ) {
          return findIndex.call(this, (value, index, array) => {
            if (isOperation(value)) {
              counts.scanned += 1
            }
            return predicate.call(thisArg, value, index, array)
          })
        })
      ]
      try {
        const log: string[] = []
        const bound = target(7, [])
        const reads: (() => void)[] = []
        vi.spyOn(bound.journal, 'readInOrder').mockImplementation(
          <T>(read: () => T): Promise<T> =>
            new Promise((resolve) => reads.push(() => resolve(read())))
        )
        const queue = () =>
          new StructuredAgentSessionSinkQueue({
            watermarks: {
              pauseQueuedBytes: 4,
              maxQueuedBytes: 8,
              lowQueuedBytes: 1,
              pauseQueuedOperations: 4,
              maxQueuedOperations: 8,
              lowQueuedOperations: 1,
              maxLifecycleQueuedBytes: 8,
              maxLifecycleQueuedOperations: 8
            }
          })
        const live = queue()
        const dropped = queue()
        const submit = (
          sink: StructuredAgentSessionSinkQueue,
          label: string,
          key?: string,
          reenter?: () => void
        ) => {
          const run = () => {
            log.push(label)
            reenter?.()
          }
          runs.add(run)
          expect(
            sink.submit({ bytes: 1, publicationKey: key, run }, { criticalRoot: true })
          ).toEqual({ accepted: true })
        }
        const fill = (sink: StructuredAgentSessionSinkQueue) => {
          for (let index = 0; index < size; index += 1) {
            submit(sink, `write:${index}`)
            submit(sink, `old:${index}`, `buffer-cost:${index}`)
          }
          for (let index = 0; index < size; index += 1) {
            submit(sink, `buffered:${index}`, `buffer-cost:${index}`)
          }
          expect(sink.state()).toMatchObject({
            queuedOperations: 2 * size,
            queuedBytes: 2 * size,
            backpressured: true,
            failed: false
          })
        }
        fill(live)
        // During bind, an issued write unbinds and buffers one further write.
        submit(live, 'reentry', undefined, () => {
          live.unbind()
          submit(live, 'from-reentry')
        })
        live.bind(bound)
        expect(log).toEqual([
          ...Array.from({ length: size }, (_, index) => `write:${index}`),
          'reentry'
        ])
        for (let index = 0; index < size; index += 1) {
          submit(live, `latest:${index}`, `buffer-cost:${index}`)
        }
        live.bind(bound)
        for (const read of reads) {
          read()
        }
        await expect(live.barrier()).resolves.toEqual({ ok: true })
        await expect(live.written()).resolves.toEqual({ ok: true })
        expect(log).toEqual([
          ...Array.from({ length: size }, (_, index) => `write:${index}`),
          'reentry',
          'from-reentry',
          ...Array.from({ length: size }, (_, index) => `latest:${index}`)
        ])
        expect(live.state()).toEqual({
          queuedOperations: 0,
          queuedBytes: 0,
          backpressured: false,
          failed: false
        })
        fill(dropped)
        const beforeDrop = [...log]
        const written = dropped.written()
        dropped.close()
        dropped.bind(bound)
        await expect(dropped.barrier()).resolves.toEqual({ ok: true })
        await expect(written).resolves.toMatchObject({ ok: false })
        expect(log).toEqual(beforeDrop)
        expect(dropped.state()).toEqual({
          queuedOperations: 0,
          queuedBytes: 0,
          backpressured: false,
          failed: false
        })
        return counts
      } finally {
        for (const spy of spies) {
          spy.mockRestore()
        }
      }
    }
    const small = await measure(200)
    const large = await measure(2000)
    const work = (count: typeof small) => count.keys + count.snapshot + count.scanned
    console.info('buffer key/snapshot work', { small, large })
    expect(small.snapshot).toBe(5 * 200 + 2)
    expect(large.snapshot).toBe(5 * 2000 + 2)
    expect(work(small)).toBeLessThanOrEqual(64 * 200 + 32)
    expect(work(large)).toBeLessThanOrEqual(64 * 2000 + 32)
    expect(work(large)).toBeLessThanOrEqual(10 * work(small) + 32)
  })

  it('buffers writes made before the journal exists and drains them in arrival order', async () => {
    const log: Recorded[] = []
    const deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())

    deferred.sink.appendItem(identity(0), BODY, { turnScope: AGENT_JOURNAL_THREAD_SCOPE })
    deferred.sink.appendItem(identity(1), BODY, { turnScope: AGENT_JOURNAL_THREAD_SCOPE })
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
    const deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())
    deferred.bind(target(1, log))

    deferred.sink.appendItem(identity(0), BODY, { turnScope: AGENT_JOURNAL_THREAD_SCOPE })
    deferred.bind(target(2, log))
    deferred.sink.appendItem(identity(1), BODY, { turnScope: AGENT_JOURNAL_THREAD_SCOPE })
    await deferred.drained()

    expect(log).toEqual([
      { call: 'appendItem', fence: 1, ordinal: 0 },
      { call: 'appendItem', fence: 2, ordinal: 1 }
    ])
  })

  it('buffers replacement-acquisition events while unbound', async () => {
    const log: Recorded[] = []
    const deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())
    deferred.bind(target(1, log))
    deferred.unbind()

    deferred.sink.appendItem(identity(0), BODY, { turnScope: AGENT_JOURNAL_THREAD_SCOPE })
    expect(log).toEqual([])
    deferred.bind(target(2, log))
    await deferred.drained()

    expect(log).toEqual([{ call: 'appendItem', fence: 2, ordinal: 0 }])
  })

  it('resolves a lifecycle transition after journal bind and skips an existing state', async () => {
    const log: Recorded[] = []
    const deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())

    expect(
      deferred.sink.tryAppendLifecycleTransition?.(identity(0), BODY, () => identity(1), {
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      })
    ).toEqual({ accepted: true })
    expect(
      deferred.sink.tryAppendLifecycleTransition?.(identity(0), BODY, () => null, {
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      })
    ).toEqual({
      accepted: true
    })
    deferred.bind(target(2, log))
    await deferred.drained()

    expect(log).toEqual([
      { call: 'appendItem', fence: 2, ordinal: 1 },
      { call: 'publish', fence: 2 }
    ])
  })

  it('drops buffered and later writes once closed, and refuses to rebind', async () => {
    const log: Recorded[] = []
    const deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())

    deferred.sink.appendItem(identity(0), BODY, { turnScope: AGENT_JOURNAL_THREAD_SCOPE })
    deferred.close()
    deferred.bind(target(3, log))
    deferred.sink.appendItem(identity(1), BODY, { turnScope: AGENT_JOURNAL_THREAD_SCOPE })
    await deferred.drained()

    expect(log).toEqual([])
  })

  it('says its writes landed only when they ran, though a close still settles drained()', async () => {
    const log: Recorded[] = []
    const deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())
    deferred.bind(target(1, log))
    deferred.sink.appendItem(identity(0), BODY, { turnScope: AGENT_JOURNAL_THREAD_SCOPE })
    expect(await deferred.sink.written?.()).toEqual({ ok: true })

    deferred.unbind()
    deferred.sink.appendItem(identity(1), BODY, { turnScope: AGENT_JOURNAL_THREAD_SCOPE })
    const written = deferred.sink.written?.()
    deferred.close()

    expect(await written).toMatchObject({ ok: false })
    expect(await deferred.drained()).toEqual({ ok: true })
    expect(log).toEqual([{ call: 'appendItem', fence: 1, ordinal: 0 }])
  })

  it('reports one refused append, fails the barrier, and stops later writes', async () => {
    const log: Recorded[] = []
    const errors: unknown[] = []
    const readingControl = { pauseReading: vi.fn(), resumeReading: vi.fn() }
    const deferred = createDeferredStructuredAgentSessionEventSink({
      ...testEventSinkLogging(),
      onFailed: (error) => errors.push(error),
      readingControl
    })
    deferred.bind(target(4, log, 0))

    deferred.sink.appendItem(identity(0), BODY, { turnScope: AGENT_JOURNAL_THREAD_SCOPE })
    const barrier = await deferred.drained()
    expect(deferred.sink.tryAppendTombstone?.(identity(1))).toEqual({
      accepted: false,
      reason: 'failed'
    })

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
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the cached-sink path reads only the logger, on the failed drain.
    const deps = {
      store: {},
      logger: createStructuredAgentSessionLogger()
    } as never
    const runtime = new StructuredAgentSessionHostRuntimeState(deps, new Map())
    const failed = runtime.eventSinkFor('session-1')
    failed.bind(target(1, [], 0))
    failed.sink.appendItem(identity(0), BODY, { turnScope: AGENT_JOURNAL_THREAD_SCOPE })
    await expect(failed.drained()).resolves.toMatchObject({ ok: false })

    const recovered = runtime.eventSinkFor('session-1')
    expect(recovered).not.toBe(failed)
    const log: Recorded[] = []
    recovered.bind(target(2, log))
    recovered.sink.appendItem(identity(1), BODY, { turnScope: AGENT_JOURNAL_THREAD_SCOPE })
    await expect(recovered.drained()).resolves.toEqual({ ok: true })
    expect(log).toEqual([{ call: 'appendItem', fence: 2, ordinal: 1 }])
  })

  it('exposes operation watermarks and resumes below the low watermark', async () => {
    const log: Recorded[] = []
    const changes: boolean[] = []
    const readingControl = { pauseReading: vi.fn(), resumeReading: vi.fn() }
    const deferred = createDeferredStructuredAgentSessionEventSink({
      ...testEventSinkLogging(),
      watermarks: {
        maxQueuedBytes: 1_000_000,
        lowQueuedBytes: 0,
        maxQueuedOperations: 2,
        lowQueuedOperations: 0
      },
      readingControl,
      onBackpressureChange: (paused) => changes.push(paused)
    })

    expect(
      deferred.sink.tryAppendItem?.(identity(0), BODY, { turnScope: AGENT_JOURNAL_THREAD_SCOPE })
    ).toEqual({ accepted: true })
    expect(
      deferred.sink.tryAppendItem?.(identity(1), BODY, { turnScope: AGENT_JOURNAL_THREAD_SCOPE })
    ).toEqual({ accepted: true })
    expect(
      deferred.sink.tryAppendItem?.(identity(2), BODY, { turnScope: AGENT_JOURNAL_THREAD_SCOPE })
    ).toEqual({
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

  it('admits a resolved append and publication as one bounded operation', async () => {
    const log: Recorded[] = []
    const deferred = createDeferredStructuredAgentSessionEventSink({
      ...testEventSinkLogging(),
      watermarks: {
        pauseQueuedOperations: 1,
        maxQueuedOperations: 2,
        lowQueuedOperations: 0,
        maxQueuedBytes: 1_000_000
      }
    })

    expect(
      deferred.sink.tryAppendItem?.(identity(0), BODY, { turnScope: AGENT_JOURNAL_THREAD_SCOPE })
    ).toEqual({ accepted: true })
    expect(
      deferred.sink.tryAppendResolvedItemAndPublish?.(identity(1), BODY, () => identity(1), {
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      })
    ).toEqual({ accepted: true })
    expect(
      deferred.sink.tryAppendItem?.(identity(2), BODY, { turnScope: AGENT_JOURNAL_THREAD_SCOPE })
    ).toEqual({
      accepted: false,
      reason: 'backpressure'
    })

    deferred.bind(target(5, log))
    await deferred.drained()
    expect(log).toEqual([
      { call: 'appendItem', fence: 5, ordinal: 0 },
      { call: 'appendItem', fence: 5, ordinal: 1 },
      { call: 'publish', fence: 5 }
    ])
  })

  it('pauses provider reading at the soft byte watermark before rejecting writes', async () => {
    const log: Recorded[] = []
    const changes: boolean[] = []
    const readingControl = { pauseReading: vi.fn(), resumeReading: vi.fn() }
    const deferred = createDeferredStructuredAgentSessionEventSink({
      ...testEventSinkLogging(),
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

    expect(
      deferred.sink.tryAppendItem?.(identity(0), BODY, { turnScope: AGENT_JOURNAL_THREAD_SCOPE })
    ).toEqual({ accepted: true })
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
      ...testEventSinkLogging(),
      onFailed: (error) => errors.push(error),
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
      [{ kind: 'item', identity: identity(0), body: BODY, turnScope: AGENT_JOURNAL_THREAD_SCOPE }],
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
      ...testEventSinkLogging(),
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

    expect(
      deferred.sink.tryAppendItem?.(identity(0), BODY, { turnScope: AGENT_JOURNAL_THREAD_SCOPE })
    ).toEqual({ accepted: true })
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

  it('applies the first lifecycle batch for a settlement once, in the journal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-event-sink-settlement-'))
    const journal = await openAgentSessionJournal({
      identity: JOURNAL_IDENTITY,
      database: openTestJournalHostDatabase(root),
      mintEpoch: () => 'epoch-1'
    })
    const deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())
    const batch = (ordinal: number) => [
      {
        kind: 'item' as const,
        identity: identity(ordinal),
        body: BODY,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      }
    ]

    deferred.sink.appendLifecycleBatch?.('turn-completed:turn-1', batch(0))
    expect(deferred.sink.tryAppendLifecycleBatch?.('turn-completed:turn-1', batch(1))).toEqual({
      accepted: true
    })
    deferred.bind({ journal, fence: 1, publish: () => {} })
    await expect(deferred.drained()).resolves.toEqual({ ok: true })

    expect(journal.snapshot().items.map((item) => item.itemId)).toEqual([
      agentJournalItemKey(identity(0))
    ])
    await journal.close()
    closeTestJournalHostDatabase(root)
    await rm(root, { recursive: true, force: true })
  })

  it('keeps a rewritten streamed row in its place ahead of what was issued after it', async () => {
    const log: Recorded[] = []
    const deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())
    const window: (() => void)[] = []
    const translator = createCodexJournalTranslator({
      sink: deferred.sink,
      sessionId: 'session-1',
      primaryThreadId: () => 'thread-1',
      schedule: (run) => {
        window.push(run)
        return () => {}
      }
    })
    const notify = (method: string, params: Record<string, unknown>) =>
      translator.handle({
        type: 'notification',
        sessionId: 'session-1',
        threadId: 'thread-1',
        method,
        params: { threadId: 'thread-1', turnId: 'turn-1', turn: { id: 'turn-1' }, ...params }
      })
    const checkpoint = (text: string) => {
      notify('item/agentMessage/delta', { itemId: 'reply', delta: text })
      for (const run of window.splice(0)) {
        run()
      }
    }
    notify('turn/started', {})
    notify('item/started', { item: { type: 'agentMessage', id: 'reply', text: '' } })
    checkpoint('Looking at the tests first. '.repeat(4))
    notify('item/completed', { item: { type: 'agentMessage', id: 'aside', text: 'An aside.' } })
    checkpoint('Then the build. '.repeat(40))

    const bound = target(6, log)
    deferred.bind(bound)
    await deferred.drained()
    const written = vi.mocked(bound.journal.appendItem).mock.calls.flatMap(([id, body]) => {
      const block = body.kind === 'message' ? body.blocks[0] : undefined
      const text = block?.type === 'text' ? block.text : ''
      return text.startsWith('Looking') || text === 'An aside.'
        ? [`${text.startsWith('Looking') ? 'reply' : 'aside'} ${agentJournalItemKey(id)}`]
        : []
    })
    const [reply, aside] = written
    expect(reply?.startsWith('reply')).toBe(true)
    expect(written).toEqual([reply, aside, reply])
  })

  it('coalesces provider activity as a publication without a journal write', async () => {
    const log: Recorded[] = []
    const deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())

    deferred.sink.setActivity?.({ turnId: 'turn-1', text: 'Thinking' })
    deferred.sink.setActivity?.({ turnId: 'turn-1', text: 'Checking the result' })
    deferred.bind(target(6, log))
    await deferred.drained()

    expect(log).toEqual([
      {
        call: 'publish',
        fence: 6,
        activity: { turnId: 'turn-1', text: 'Checking the result' }
      }
    ])
  })
})

describe('producer linkage reaches the journal through every append path', () => {
  const LINKAGE = {
    agentId: 'task-1',
    parentAgentId: 'task-parent',
    providerParentRef: 'toolu_1',
    producerKind: 'agent',
    attempt: 2
  } as const

  it('forwards the whole bundle on the plain and try append paths', async () => {
    for (const append of ['appendItem', 'tryAppendItem'] as const) {
      const log: Recorded[] = []
      const deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())
      deferred.bind(target(5, log))
      deferred.sink[append]?.(identity(1), BODY, {
        ...LINKAGE,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      })
      await deferred.drained()

      expect(journalAppendOptions).toEqual([
        { fence: 5, ownerFence: 5, turnScope: AGENT_JOURNAL_THREAD_SCOPE, ...LINKAGE }
      ])
      deferred.close()
    }
  })

  it('forwards it on the resolved-append and lifecycle-transition paths', async () => {
    // Goal rows use resolved transitions; lost linkage would misattribute them to root.
    for (const append of [
      'tryAppendResolvedItem',
      'tryAppendResolvedItemAndPublish',
      'tryAppendLifecycleTransition'
    ] as const) {
      const log: Recorded[] = []
      const deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())
      deferred.bind(target(5, log))
      deferred.sink[append]?.(identity(1), BODY, () => identity(1), {
        ...LINKAGE,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      })
      await deferred.drained()

      expect(journalAppendOptions).toEqual([
        { fence: 5, ownerFence: 5, turnScope: AGENT_JOURNAL_THREAD_SCOPE, ...LINKAGE }
      ])
      deferred.close()
    }
  })

  it('does NOT forward it on the lifecycle-batch path, which is one row for N mutations', async () => {
    // Mixed-agent batches need per-mutation linkage; row-level stamping would misattribute their contents.
    const log: Recorded[] = []
    const deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())
    deferred.bind(target(5, log))
    deferred.sink.appendLifecycleBatch?.(
      'settle-1',
      [{ kind: 'item', identity: identity(1), body: BODY, turnScope: AGENT_JOURNAL_THREAD_SCOPE }],
      { ...LINKAGE }
    )

    await deferred.drained()

    expect(journalAppendOptions).toEqual([{ fence: 5 }])
    deferred.close()
  })

  it("writes no linkage keys at all for the session's own agent", async () => {
    const log: Recorded[] = []
    const deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())
    deferred.bind(target(5, log))
    deferred.sink.appendItem(identity(1), BODY, { turnScope: AGENT_JOURNAL_THREAD_SCOPE })
    await deferred.drained()

    // Presence matters: root writes must omit linkage keys, not set them undefined.
    // Provider observations still stamp their bound execution fence.
    expect(journalAppendOptions).toEqual([
      { fence: 5, ownerFence: 5, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    ])
    deferred.close()
  })
})
