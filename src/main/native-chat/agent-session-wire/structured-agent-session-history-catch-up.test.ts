import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-host-database-test-support'
import type { StructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import { createDeferredStructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import { testEventSinkLogging } from './structured-agent-session-logger-test-support'
import type { HistoryCatchUpPlan } from './structured-agent-session-history-catch-up'
import {
  createHistoryCatchUpBatch,
  runHistoryCatchUp
} from './structured-agent-session-history-catch-up'

describe('history catch-up runner', () => {
  afterEach(() => vi.useRealTimers())
  function fixture() {
    let barriers = 0
    const journal = {
      epoch: 'epoch-1',
      cursor: () => ({ epoch: 'epoch-1', sequence: 0 }),
      item: () => null,
      itemBody: () => null,
      canonicalItemId: (key: string) => key,
      visitItems: vi.fn(),
      visitItemsWithLinkage: vi.fn(),
      receiptFor: () => null,
      submissions: () => [],
      historyOrigin: () => null
    }
    const append = vi.fn<NonNullable<StructuredAgentSessionEventSink['tryAppendTransition']>>(
      () => ({ accepted: true })
    )
    const sink: StructuredAgentSessionEventSink = {
      appendItem: vi.fn(),
      appendTombstone: vi.fn(),
      publish: vi.fn(),
      // The barrier before reading settles; the one after the commit never does.
      written: () => (barriers++ === 0 ? Promise.resolve({ ok: true }) : new Promise(() => {})),
      journalHistory: () => journal,
      journalItems: () => journal,
      tryAppendTransition: append
    }
    const logger = { warn: vi.fn(), error: vi.fn() }
    const input: Parameters<typeof runHistoryCatchUp<string>>[0] = {
      agentName: 'Test',
      scope: 'test-catch-up',
      sessionId: 'session-1',
      sink,
      timeoutMs: 50,
      logger,
      readView: () => 'view',
      sameView: (a, b) => a === b,
      prepare: async () => plan
    }
    return { input, append, journal, logger }
  }
  const plan: HistoryCatchUpPlan = {
    settlementId: 's',
    mutations: [{ kind: 'tombstone', identity: { provider: 'orca', clientMessageId: 'old' } }],
    keys: [agentJournalItemKey({ provider: 'orca', clientMessageId: 'old' })],
    reservedBytes: 1
  }
  it('gives up at the deadline when the commit never becomes durable', async () => {
    const { input, append, journal, logger } = fixture()
    const started = Date.now()
    const outcome = await runHistoryCatchUp(input)
    expect(outcome).toBe('skipped')
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(logger.warn).toHaveBeenCalledWith(
      'Test chat did not catch up on turns made outside it',
      expect.objectContaining({ reason: 'import-skipped' })
    )
    expect(append.mock.calls[0]?.[0].steps[0]?.resolve(journal)).toEqual([])
  })
  it('abandons stalled preparation at its deadline or parent cancellation without late admission', async () => {
    vi.useFakeTimers()
    for (const parent of [undefined, new AbortController()]) {
      const late = Promise.withResolvers<HistoryCatchUpPlan | null>()
      const { input, append } = fixture()
      input.prepare = () => late.promise
      const outcome = runHistoryCatchUp({ ...input, signal: parent?.signal })
      await vi.advanceTimersByTimeAsync(parent ? 0 : 50)
      parent?.abort()
      expect(await outcome).toBe('skipped')
      if (parent) {
        late.reject(new Error('late source failure'))
      } else {
        late.resolve(plan)
      }
      await vi.advanceTimersByTimeAsync(0)
      expect(append).not.toHaveBeenCalled()
    }
  })
  it('checks absolute time after preparation even before timer delivery, including a no-op', async () => {
    vi.useFakeTimers()
    for (const prepared of [plan, null]) {
      const { input, append } = fixture()
      input.prepare = async () => {
        vi.setSystemTime(Date.now() + 51)
        return prepared
      }
      expect(await runHistoryCatchUp(input)).toBe('skipped')
      expect(append).not.toHaveBeenCalled()
    }
  })
  it('revokes an admitted resolver after an early failed barrier', async () => {
    const { input, append, journal } = fixture()
    input.sink.written = vi
      .fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValue({ ok: false, error: new Error('write failed') })
    expect(await runHistoryCatchUp(input)).toBe('skipped')
    const step = append.mock.calls[0]?.[0].steps[0]
    expect(step?.resolve(journal)).toEqual([])
  })
  it('completes saved items only while all saved reads match, and checks empty plans without writes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-31622-expected-items-'))
    const journals = createTrackedJournalOpener()
    const deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())
    try {
      const journal = await journals.open({
        stateDirectory: root,
        identity: {
          sessionId: 'expected-items',
          workspaceId: 'ws',
          hostId: 'local',
          agent: 'codex',
          providerHandle: codexProviderHandle('thread')
        }
      })
      const publish = vi.fn()
      deferred.bind({ journal, fence: 1, publish })
      const identity = { provider: 'codex' as const, threadId: 't', turnId: 't', ordinal: 0 }
      const parent = { ...identity, ordinal: 1 }
      const key = agentJournalItemKey(identity)
      const parentKey = agentJournalItemKey(parent)
      const body = (text: string) => ({
        kind: 'message' as const,
        role: 'assistant' as const,
        blocks: [{ type: 'text' as const, text }]
      })
      const options = { fence: 1, turnScope: { kind: 'thread' as const } }
      await journal.appendItem(identity, body('prefix'), options)
      await journal.appendItem(parent, body('eligible parent'), options)
      const original = journal.item(key)
      const expected = (itemKey: string) => {
        const item = journal.item(itemKey)
        if (!item) {
          throw new Error('missing saved item')
        }
        return { canonicalItemId: item.itemId, revision: item.revision }
      }
      const make = (text: string) => {
        const batch = createHistoryCatchUpBatch()
        batch.revise(
          { kind: 'item', identity, body: body(text), turnScope: options.turnScope },
          expected(key)
        )
        batch.expectItem(parentKey, expected(parentKey))
        return batch.finish('complete', ['same source keys'])
      }
      const { input } = fixture()
      const run = (prepared: HistoryCatchUpPlan) =>
        runHistoryCatchUp({
          ...input,
          sink: deferred.sink,
          timeoutMs: 5_000,
          prepare: async () => prepared
        })
      const first = make('complete')
      expect(make('different contents').settlementId).not.toBe(first.settlementId)
      expect(await run(first)).toBe('committed')
      expect(journal.item(key)).toMatchObject({
        ...original,
        body: body('complete'),
        revision: (original?.revision ?? -1) + 1
      })
      const stale = make('later completion')
      await journal.appendItem(parent, body('changed parent'), options)
      const before = journal.cursor()
      expect(await run(stale)).toBe('skipped')
      expect(journal.cursor()).toEqual(before)
      expect(journal.itemBody(key)).toEqual(body('complete'))
      const empty = createHistoryCatchUpBatch()
      empty.expectItem(key, expected(key))
      const publications = publish.mock.calls.length
      expect(await run(empty.finish('checked', []))).toBe('checked')
      expect(journal.cursor()).toEqual(before)
      expect(publish).toHaveBeenCalledTimes(publications)
    } finally {
      deferred.close()
      await journals.closeAll()
      await rm(root, { recursive: true, force: true })
    }
  })
})
