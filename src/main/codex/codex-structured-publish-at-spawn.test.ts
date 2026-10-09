import { describe, expect, it, vi } from 'vitest'
import { CodexAppServerRequestError } from './codex-app-server-connection'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { agentSessionFailureWords } from '../../shared/agent-session-failure-words'
import { providerDiagnostic, withProviderDiagnostic } from '../../shared/agent-session-failure'
import type { CodexStructuredSessionEvent } from './codex-structured-session-adapter'
import {
  adapterFor,
  fakeCodex,
  identityFor,
  THREAD_ID
} from './codex-structured-session-adapter-fixture'

const INPUT = { identity: identityFor('session-1'), fence: 7, spawnToken: 'spawn-9' }

function startup(routes: Parameters<typeof fakeCodex>[0] = {}) {
  const events: CodexStructuredSessionEvent[] = []
  const codex = fakeCodex(routes)
  const adapter = adapterFor(codex, {}, [], { onEvent: (event) => events.push(event) })
  return { events, codex, adapter }
}

describe('Codex startup publishes its child before the handshake', () => {
  it('returns the recorded process while initialize is held, without inventing a thread link', async () => {
    const gate = Promise.withResolvers<unknown>()
    const { adapter, codex, events } = startup({ initialize: () => gate.promise })
    const committed = Promise.withResolvers<void>()
    const onSpawned = vi.fn(async () => committed.promise)
    const acquiring = adapter.acquire({ ...INPUT, onSpawned })
    await vi.waitFor(() => expect(onSpawned).toHaveBeenCalledOnce())
    expect(codex.connections[0].calls).toEqual([])
    committed.resolve()
    const acquisition = await acquiring
    expect(acquisition.process.pid).toBe(4321)
    expect(acquisition.link).toBeUndefined()
    expect(events).toEqual([])
    expect(
      adapter.holdsLiveProviderProcess('session-1', acquisition.acquisitionGeneration ?? '')
    ).toBe(true)
    expect(codex.connections[0].calls.map((call) => call.method)).toEqual(['initialize'])
    gate.resolve({})
    await vi.waitFor(() =>
      expect(events.filter((event) => event.type === 'started')).toHaveLength(1)
    )
    await adapter.closeAll()
  })

  it('reports the real thread and saved options after open, before optional catalog reads', async () => {
    const thread = Promise.withResolvers<unknown>()
    const catalog = Promise.withResolvers<unknown>()
    const { adapter, codex, events } = startup({
      'thread/start': () => thread.promise,
      'model/list': () => {
        expect(events.some((event) => event.type === 'started')).toBe(true)
        return catalog.promise
      }
    })
    let revision = 2
    await adapter.acquire({
      ...INPUT,
      options: { model: 'gpt-saved', effort: 'low', fastMode: 'true' },
      optionRevision: () => revision
    })
    await vi.waitFor(() => expect(codex.connections[0].calls.at(-1)?.method).toBe('thread/start'))
    expect(events).toEqual([])
    revision = 3
    thread.resolve({ thread: { id: THREAD_ID }, model: 'gpt-old', reasoningEffort: 'high' })
    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'started',
          link: expect.objectContaining({
            handle: expect.objectContaining({ nativeId: THREAD_ID })
          }),
          reportedOptions: { model: 'gpt-saved', effort: 'low', fastMode: true },
          restoreSkippedOptions: [],
          optionRevision: 2
        })
      )
    )
    revision = 4
    catalog.resolve({
      data: [{ model: 'gpt-saved', supportedReasoningEfforts: [] }],
      nextCursor: null
    })
    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({ type: 'options-reported', optionRevision: 3 })
      )
    )
    await adapter.closeAll()
  })

  it.each(['initialize', 'thread/start'])(
    'reaps a failed %s and keeps the provider diagnostic',
    async (method) => {
      const gate = Promise.withResolvers<unknown>()
      const { adapter, codex, events } = startup({ [method]: () => gate.promise })
      await adapter.acquire(INPUT)
      await vi.waitFor(() => expect(codex.connections[0].calls.at(-1)?.method).toBe(method))
      gate.reject(new CodexAppServerRequestError(method, -32603, 'not signed in', 'not signed in'))
      await vi.waitFor(() =>
        expect(events).toContainEqual(
          expect.objectContaining({
            type: 'ended',
            cause: 'unexpected-exit',
            startupUnproven: true,
            ...(method === 'initialize' ? { startupUnanswered: true } : {}),
            failure: {
              kind: 'providerExited',
              detail: { text: 'not signed in', audience: 'person' }
            }
          })
        )
      )
      const end = events.find((event) => event.type === 'ended')
      if (method === 'thread/start' && end && 'startupUnanswered' in end) {
        expect(end.startupUnanswered).toBeUndefined()
      }
      expect(events.filter((event) => event.type === 'started')).toEqual([])
      expect(codex.connections[0].closeCount).toBe(1)
      await adapter.closeAll()
    }
  )

  it.each(['closeSession', 'disposeSession', 'forceCloseSession', 'releaseAcquisition'] as const)(
    'lets %s stop a held handshake with no late started',
    async (method) => {
      const gate = Promise.withResolvers<unknown>()
      const { adapter, codex, events } = startup({ initialize: () => gate.promise })
      await adapter.acquire(INPUT)
      const closed =
        method === 'releaseAcquisition'
          ? await adapter.releaseAcquisition({ sessionId: 'session-1' })
          : await adapter[method]('session-1')
      expect(closed).toBe(true)
      expect(codex.connections[0].closeCount).toBe(1)
      gate.resolve({})
      await vi.waitFor(() =>
        expect(events.filter((event) => event.type === 'ended')).toHaveLength(1)
      )
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(events.filter((event) => event.type === 'started')).toEqual([])
      expect(codex.connections[0].calls.some((call) => call.method === 'thread/start')).toBe(false)
    }
  )

  it('ends a child that exits before thread open, without publishing a started event', async () => {
    const gate = Promise.withResolvers<unknown>()
    const { adapter, codex, events } = startup({ 'thread/start': () => gate.promise })
    await adapter.acquire(INPUT)
    await vi.waitFor(() => expect(codex.connections[0].calls.at(-1)?.method).toBe('thread/start'))
    codex.connections[0].closed = true
    codex.connections[0].handlers.onExit?.(new Error('child exited'))
    gate.resolve({ thread: { id: THREAD_ID } })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(events.filter((event) => event.type === 'started')).toEqual([])
    expect(events).toContainEqual(expect.objectContaining({ type: 'ended', startupUnproven: true }))
    await adapter.closeAll()
  })

  it('publishes the resumed thread link only after thread/resume answers', async () => {
    const gate = Promise.withResolvers<unknown>()
    const codex = fakeCodex({ 'thread/resume': () => gate.promise })
    const events: CodexStructuredSessionEvent[] = []
    const adapter = adapterFor(codex, { resumeThreadId: THREAD_ID }, [], {
      onEvent: (event) => events.push(event)
    })
    const acquired = await adapter.acquire(INPUT)
    expect(acquired.link).toBeUndefined()
    await vi.waitFor(() => expect(codex.connections[0].calls.at(-1)?.method).toBe('thread/resume'))
    gate.resolve({ thread: { id: THREAD_ID } })
    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'started',
          link: expect.objectContaining({
            origin: 'resumed',
            handle: expect.objectContaining({ nativeId: THREAD_ID })
          })
        })
      )
    )
    await adapter.closeAll()
  })
  it('preserves the history-too-large refusal words when restoration ends startup', async () => {
    const { adapter, codex, events } = startup({
      'thread/start': () => ({
        thread: {
          id: THREAD_ID,
          turns: [
            {
              id: 'old-turn',
              items: Array.from({ length: 1_025 }, (_, i) => ({
                type: 'agentMessage',
                id: `old-${i}`,
                text: 'old message'
              }))
            }
          ]
        }
      })
    })
    const sink: StructuredAgentSessionEventSink = {
      appendItem: vi.fn(),
      appendTombstone: vi.fn(),
      publish: vi.fn()
    }
    await adapter.acquire({ ...INPUT, events: sink })
    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'ended',
          startupUnproven: true,
          failure: { kind: 'historyTooLarge' }
        })
      )
    )
    const event = events.find((entry) => entry.type === 'ended' && 'failure' in entry)
    if (!event || !('failure' in event) || !event.failure) {
      throw new Error('No failure')
    }
    expect(agentSessionFailureWords(event.failure, { surface: 'rejection' }).reason).toBe(
      "This conversation's history is too large to restore here. Start a new chat to continue."
    )
    expect(sink.appendItem).not.toHaveBeenCalled()
    expect(codex.connections[0].closeCount).toBe(1)
  })

  it('keeps the exit diagnostic when an initialization timeout has no provider words', async () => {
    const gate = Promise.withResolvers<unknown>()
    const { adapter, codex, events } = startup({ initialize: () => gate.promise })
    await adapter.acquire(INPUT)
    codex.connections[0].close = async () => {
      codex.connections[0].closed = true
      codex.connections[0].handlers.onExit?.(
        withProviderDiagnostic(
          new Error('child exited'),
          providerDiagnostic('Please sign in to Codex', 'person')
        ),
        { expected: true }
      )
      return true
    }
    gate.reject(new Error('initialize timed out'))
    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'ended',
          startupUnproven: true,
          startupUnanswered: true,
          failure: {
            kind: 'providerExited',
            detail: { text: 'Please sign in to Codex', audience: 'person' }
          }
        })
      )
    )
  })
  it('reports a failure while draining early frames once, and leaves no retained acquisition', async () => {
    const codex = fakeCodex()
    const events: CodexStructuredSessionEvent[] = []
    codex.routes['thread/start'] = () => {
      codex.connections[0].handlers.onNotification?.('item/started', { threadId: THREAD_ID })
      return { thread: { id: THREAD_ID } }
    }
    const adapter = adapterFor(codex, {}, [], {
      onEvent: (event) => {
        if (event.type === 'notification') {
          throw new Error('early event failed')
        }
        events.push(event)
      }
    })
    await adapter.acquire(INPUT)
    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({ type: 'ended', startupUnproven: true })
      )
    )
    await adapter.closeAll()
    expect(events.filter((event) => event.type === 'ended')).toHaveLength(1)
    expect(events.some((event) => event.type === 'started')).toBe(false)
    expect(codex.connections[0].closeCount).toBe(1)
  })
})
