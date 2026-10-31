import { expect, it, vi } from 'vitest'
import {
  checkpointJournalRig,
  closeCheckpointTestJournals
} from '../claude/claude-checkpoint-test-support'
import {
  acquireReadyCodexForTest,
  adapterFor,
  fakeCodex,
  identityFor,
  THREAD_ID,
  USER_MESSAGE
} from './codex-structured-session-adapter-fixture'
import type { CodexStructuredSessionEvent } from './codex-structured-session-adapter'
import type { JournalRow } from '../native-chat/agent-session-journal/journal-row-schema'
import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionSinkAdmission
} from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { selectStructuredAgentContextUsage } from '../../shared/structured-agent-session-context-usage'
import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'

// Captured app-server 0.161.0 shape; the pressure schedule and smaller watermarks are synthetic.
const contextUsage = {
  total: {
    totalTokens: 17611,
    inputTokens: 17606,
    cachedInputTokens: 12288,
    cacheWriteInputTokens: 0,
    outputTokens: 5,
    reasoningOutputTokens: 0
  },
  last: {
    totalTokens: 17611,
    inputTokens: 17606,
    cachedInputTokens: 12288,
    cacheWriteInputTokens: 0,
    outputTokens: 5,
    reasoningOutputTokens: 0
  },
  modelContextWindow: 258400
}

it.each([
  { channel: 'agentMessage', pending: true },
  { channel: 'reasoning', pending: false }
] as const)(
  'retains acquired $channel usage under native pressure with pending=$pending until context commits before follow-up',
  async ({ channel, pending }) => {
    const r = await checkpointJournalRig({
      watermarks: {
        maxQueuedOperations: 4,
        maxLifecycleQueuedOperations: 4,
        lowQueuedOperations: 0,
        lowQueuedBytes: 0
      }
    })
    r.translator.dispose()
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] })
    const codex = fakeCodex({ 'turn/start': () => ({ turn: { id: 'turn' } }) })
    let readingPaused = false
    const open = codex.openConnection
    codex.openConnection = async (...args) => {
      const connection = await open(...args)
      connection.pauseReading = () => {
        readingPaused = true
      }
      connection.resumeReading = () => {
        readingPaused = false
      }
      return connection
    }
    const events: CodexStructuredSessionEvent[] = []
    const adapter = adapterFor(codex, {}, events)
    const gate = Promise.withResolvers<void>()
    const inputs: JournalRow[] = []
    r.journal.observeCommits((rows) => inputs.push(...(rows ?? [])))
    const published: unknown[] = []
    r.publish.mockImplementation(() => {
      published.push(selectStructuredAgentContextUsage(r.journal.snapshot().items))
    })
    const revise = vi.fn(r.deferred.sink.tryReviseResolvedItemAndPublish!.bind(r.deferred.sink))
    r.deferred.sink.tryReviseResolvedItemAndPublish = revise
    try {
      await acquireReadyCodexForTest(adapter, {
        identity: identityFor('session-1'),
        fence: 7,
        spawnToken: 'usage-pressure',
        events: r.deferred.sink
      })
      await expect(
        adapter.dispatch({
          sessionId: 'session-1',
          clientMessageId: 'pending-send',
          fence: 7,
          body: USER_MESSAGE
        })
      ).resolves.toMatchObject({ state: 'admitted' })
      const connection = codex.connections[0]
      const notify = (method: string, params: Record<string, unknown>) =>
        connection.handlers.onNotification?.(method, { threadId: THREAD_ID, ...params })
      notify('turn/started', { turn: { id: 'turn' } })
      await r.deferred.drained()
      notify('item/started', { turnId: 'turn', item: { type: channel, id: 'text' } })
      const delta =
        channel === 'agentMessage' ? 'item/agentMessage/delta' : 'item/reasoning/textDelta'
      const prefix = 'P'.repeat(100),
        tail = pending ? 'T'.repeat(40) : ''
      notify(delta, { itemId: 'text', delta: prefix })
      await vi.advanceTimersByTimeAsync(60)
      await r.deferred.drained()
      const first = structuredClone(
        r.journal.snapshot().items.find((item) => item.body.kind === 'message')!
      )
      expect(first.body).toMatchObject({ blocks: [{ type: 'text', text: prefix }] })
      await vi.advanceTimersByTimeAsync(40)
      if (pending) {
        notify(delta, { itemId: 'text', delta: tail })
      }
      await vi.advanceTimersByTimeAsync(10)
      await r.journal.readInOrder(() => {
        void r.journal.readInOrder(() => gate.promise)
      })
      const fill = (uuid: string, lifecycle = false) =>
        r.deferred.sink.tryAppendItem!(
          { provider: 'claude', sessionId: 'block', uuid },
          { kind: 'status', text: uuid },
          { turnScope: { kind: 'thread' }, ...(lifecycle ? { lifecycle: true } : {}) }
        )
      for (const lifecycle of [false, true]) {
        for (let n = 0; n < 4; n++) {
          expect(fill(`${lifecycle}-${n}`, lifecycle)).toEqual({ accepted: true })
        }
        expect(fill(`${lifecycle}-overflow`, lifecycle)).toEqual({
          accepted: false,
          reason: 'backpressure'
        })
      }
      expect(r.deferred.state().queuedOperations).toBe(8)
      const acceptedUsage = () =>
        events.filter(
          (event) => event.type === 'notification' && event.method === 'thread/tokenUsage/updated'
        )
      const start = revise.mock.results.length
      notify('thread/tokenUsage/updated', { turnId: 'turn', tokenUsage: contextUsage })
      expect(revise.mock.results.at(-1)?.value).toEqual({ accepted: false, reason: 'backpressure' })
      const held = { accepted: acceptedUsage().length, paused: readingPaused }
      const beforeRetry = revise.mock.results.length
      await vi.advanceTimersByTimeAsync(25)
      const retryAttempts = revise.mock.results.length - beforeRetry
      expect(revise.mock.results.at(-1)?.value).toEqual({ accepted: false, reason: 'backpressure' })
      gate.resolve()
      expect(await r.deferred.drained()).toEqual({ ok: true })
      await vi.advanceTimersByTimeAsync(25)
      expect(await r.deferred.drained()).toEqual({ ok: true })
      // Measure metadata before any later provider event can rescue it.
      const reading = selectStructuredAgentContextUsage(r.journal.snapshot().items)
      const committedContext = inputs.filter(
        (row) => row.kind === 'item' && readAgentJournalTurn(row.body)?.contextUsage
      )
      const contextPublications = published.filter((value) => value !== null).length
      const admitted = revise.mock.results
        .slice(start)
        .filter((result) => result.type === 'return' && result.value.accepted).length
      expect(readingPaused).toBe(false)
      expect(connection.closeCount).toBe(0)
      expect(adapter.heldSends('session-1')).toEqual(new Set(['pending-send']))
      expect(r.journal.item(first.itemId)).toEqual(first)
      notify('item/completed', { turnId: 'turn', item: { type: channel, id: 'text' } })
      await r.deferred.drained()
      const final = r.journal.item(first.itemId)
      expect(final).toMatchObject({
        ...first,
        revision: first.revision + 1,
        body: { blocks: [{ type: 'text', text: prefix + tail }] }
      })
      notify('item/completed', {
        turnId: 'turn',
        item: { type: 'userMessage', id: 'echo', clientId: 'pending-send' }
      })
      await r.deferred.drained()
      expect(adapter.heldSends('session-1')?.size).toBe(0)
      expect(
        events.filter((event) => event.type === 'notification' && event.method === 'item/completed')
      ).toHaveLength(2)
      expect(vi.getTimerCount()).toBe(0)
      expect(readingPaused).toBe(false)
      await adapter.closeAll()
      await r.deferred.drained()
      const saved = structuredClone(r.journal.snapshot().items)
      await r.journal.close()
      const reopened = await r.reopen()
      expect(reopened.snapshot().items).toEqual(saved)
      expect(reopened.item(first.itemId)).toEqual(final)
      console.info(
        'context-refusal-iteration',
        JSON.stringify({
          channel,
          pending,
          held,
          retryAttempts,
          attempts: revise.mock.results.slice(start).map((result) => result.value),
          admitted,
          committedContextInputs: committedContext.length,
          contextPublications,
          reading,
          first,
          final
        })
      )
      // Keep the negative running through textless final, real echo and fresh reopen.
      expect(held).toEqual({ accepted: 0, paused: true })
      expect(retryAttempts).toBeGreaterThan(0)
      expect(admitted).toBe(1)
      expect(committedContext).toHaveLength(1)
      expect(contextPublications).toBe(1)
      expect(acceptedUsage()).toHaveLength(1)
      expect(acceptedUsage()[0]).toMatchObject({
        sessionId: 'session-1',
        threadId: THREAD_ID,
        params: { turnId: 'turn', tokenUsage: contextUsage }
      })
      expect(acceptedUsage()[0]).not.toHaveProperty('observedAt')
      expect(
        events.find((event) => event.type === 'notification' && event.method === 'turn/started')
      ).toMatchObject({ observedAt: 1_700_000_000_500, dispatchSequenceAtReceipt: 0 })
      expect(reading).toMatchObject({ usedTokens: 17611, windowTokens: 258400 })
      expect(selectStructuredAgentContextUsage(reopened.snapshot().items)).toEqual(reading)
    } finally {
      gate.resolve()
      await adapter.closeAll()
      await closeCheckpointTestJournals()
      vi.useRealTimers()
    }
  }
)

it.each(['closed', 'failed', 'replaced'] as const)(
  'settles the selected context refusal through the acquired owner on %s',
  async (boundary) => {
    const r = await checkpointJournalRig()
    r.translator.dispose()
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] })
    const codex = fakeCodex()
    let readingPaused = false
    const open = codex.openConnection
    codex.openConnection = async (...args) => {
      const connection = await open(...args)
      connection.pauseReading = () => {
        readingPaused = true
      }
      connection.resumeReading = () => {
        readingPaused = false
      }
      return connection
    }
    const events: CodexStructuredSessionEvent[] = []
    const adapter = adapterFor(codex, {}, events)
    const original: StructuredAgentSessionSinkAdmission = {
      accepted: false,
      reason: boundary === 'replaced' ? 'backpressure' : boundary
    }
    const revise = vi.fn<
      NonNullable<StructuredAgentSessionEventSink['tryReviseResolvedItemAndPublish']>
    >(() => original)
    try {
      await acquireReadyCodexForTest(adapter, {
        identity: identityFor('session-1'),
        fence: 7,
        spawnToken: 'usage-terminal',
        events: r.deferred.sink
      })
      const connection = codex.connections[0]
      connection.handlers.onNotification?.('turn/started', {
        threadId: THREAD_ID,
        turn: { id: 'turn' }
      })
      await r.deferred.drained()
      r.deferred.sink.tryReviseResolvedItemAndPublish = revise
      const publishedContext: unknown[] = []
      r.publish.mockImplementation(() => {
        publishedContext.push(selectStructuredAgentContextUsage(r.journal.snapshot().items))
      })
      connection.handlers.onNotification?.('thread/tokenUsage/updated', {
        threadId: THREAD_ID,
        turnId: 'turn',
        tokenUsage: contextUsage
      })
      if (boundary === 'replaced') {
        expect(readingPaused).toBe(true)
        await vi.advanceTimersByTimeAsync(25)
        await acquireReadyCodexForTest(adapter, {
          identity: identityFor('session-1'),
          fence: 8,
          spawnToken: 'usage-successor'
        })
      }
      await vi.advanceTimersByTimeAsync(100)
      expect(revise.mock.results.every((result) => result.value === original)).toBe(true)
      expect(revise).toHaveBeenCalled()
      expect(connection.closeCount).toBe(1)
      expect(readingPaused).toBe(false)
      expect(vi.getTimerCount()).toBe(0)
      expect(
        events.filter(
          (event) => event.type === 'notification' && event.method === 'thread/tokenUsage/updated'
        )
      ).toEqual([])
      expect(publishedContext.filter((value) => value !== null)).toEqual([])
      expect(selectStructuredAgentContextUsage(r.journal.snapshot().items)).toBeNull()
      if (boundary === 'replaced') {
        expect(codex.connections[1].closeCount).toBe(0)
        expect(adapter.backgroundTaskStops('session-1')).toBeDefined()
      } else {
        expect(events.filter((event) => event.type === 'ended')).toMatchObject([
          {
            reason: `notification admission failed (${boundary})`,
            fence: 7,
            acquisitionGeneration: 'generation-1'
          }
        ])
        expect(events.filter((event) => event.type === 'ended')).toHaveLength(1)
      }
    } finally {
      await adapter.closeAll()
      await closeCheckpointTestJournals()
      vi.useRealTimers()
    }
  }
)
