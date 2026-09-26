import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeStructuredSessionAdapterDeps } from './claude-structured-session-adapter'
import type { ClaudeStructuredSessionEvent } from './claude-structured-session-state'
import {
  adapterAtPublishFor,
  fakeClaude,
  identityFor,
  USER_MESSAGE
} from './claude-structured-session-test-support'
import { CLAUDE_DEFAULT_REQUEST_TIMEOUT_MS } from './claude-agent-sdk-control-requests'

type LateSettlement = Parameters<
  NonNullable<ClaudeStructuredSessionAdapterDeps['onDispatchSettledLate']>
>[0]

const SLOW_INIT_MS = 12_000

function startingAdapter(claude: ReturnType<typeof fakeClaude>): {
  adapter: ReturnType<typeof adapterAtPublishFor>
  events: ClaudeStructuredSessionEvent[]
  late: LateSettlement[]
} {
  const events: ClaudeStructuredSessionEvent[] = []
  const late: LateSettlement[] = []
  const adapter = adapterAtPublishFor(
    claude,
    {},
    events,
    [],
    undefined,
    undefined,
    undefined,
    (settlement) => late.push(settlement)
  )
  return { adapter, events, late }
}

const ACQUIRE = { identity: identityFor(), fence: 7, spawnToken: 'spawn-9' }
const PROMPT = { sessionId: 'session-1', clientMessageId: 'client-1', body: USER_MESSAGE, fence: 7 }

describe('Claude structured session publishes before the CLI answers initialize', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('creates a session whose init takes longer than any old deadline, then reports its facts', async () => {
    const claude = fakeClaude({ initDelayMs: SLOW_INIT_MS })
    const { adapter, events } = startingAdapter(claude)

    await expect(adapter.acquire(ACQUIRE)).resolves.toBeDefined()
    expect(events.some((event) => event.type === 'options')).toBe(false)
    expect(adapter.readCommands('session-1')).toBeUndefined()

    await vi.advanceTimersByTimeAsync(SLOW_INIT_MS)
    await adapter.drainStartup('session-1')

    expect(events.find((event) => event.type === 'options')).toMatchObject({
      models: [{ value: 'claude-sonnet' }]
    })
    expect(events.some((event) => event.type === 'ended')).toBe(false)
    expect(claude.connections[0].closeCount).toBe(0)
    await adapter.closeAll()
  })

  it('reports `started` once saved options are restored, before any held prompt is written', async () => {
    const claude = fakeClaude({ initDelayMs: SLOW_INIT_MS, initModel: 'claude-opus-9' })
    const { adapter, events } = startingAdapter(claude)
    const order: string[] = []
    claude.routes.set_model = () => {
      order.push('set_model')
      return undefined
    }
    await adapter.acquire({ ...ACQUIRE, options: { model: 'opus' } })
    await adapter.dispatch(PROMPT)
    expect(events.some((event) => event.type === 'started')).toBe(false)

    await vi.advanceTimersByTimeAsync(SLOW_INIT_MS)
    await adapter.drainStartup('session-1')

    const startedAt = events.findIndex((event) => event.type === 'started')
    expect(events[startedAt]).toEqual({
      type: 'started',
      sessionId: 'session-1',
      fence: 7,
      acquisitionGeneration: expect.any(String),
      // What the restore just proved, carried so the host never asks the CLI again.
      reportedOptions: expect.objectContaining({ model: 'opus' }),
      restoreSkippedOptions: []
    })
    // The restore wrote the saved model before `started`, and the held prompt only after it.
    expect(order).toEqual(['set_model'])
    expect(claude.connections[0].sent).toHaveLength(1)
    expect(events.slice(0, startedAt).some((event) => event.type === 'options')).toBe(true)
    await adapter.closeAll()
  })

  it('lets an option write wait for startup instead of refusing it', async () => {
    const claude = fakeClaude({ initDelayMs: SLOW_INIT_MS })
    const { adapter } = startingAdapter(claude)
    await adapter.acquire(ACQUIRE)
    const pick = { sessionId: 'session-1', key: 'model', value: 'opus', fence: 7 }
    await expect(adapter.setOption(pick)).rejects.toThrow('still starting')

    let writable = false
    const waited = adapter.awaitOptionWritable('session-1').then(() => {
      writable = true
    })
    await vi.advanceTimersByTimeAsync(SLOW_INIT_MS - 1)
    expect(writable).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await waited

    await expect(adapter.setOption(pick)).resolves.toMatchObject({ model: 'opus' })
    await adapter.closeAll()
  })

  it('stops waiting on a start that never lands, so the write is refused as before', async () => {
    const claude = fakeClaude({ initDelayMs: 10 * CLAUDE_DEFAULT_REQUEST_TIMEOUT_MS })
    const { adapter } = startingAdapter(claude)
    await adapter.acquire(ACQUIRE)
    let writable = false
    void adapter.awaitOptionWritable('session-1').then(() => {
      writable = true
    })
    await vi.advanceTimersByTimeAsync(CLAUDE_DEFAULT_REQUEST_TIMEOUT_MS)
    expect(writable).toBe(true)
    await expect(
      adapter.setOption({ sessionId: 'session-1', key: 'model', value: 'opus', fence: 7 })
    ).rejects.toThrow('still starting')
    await adapter.closeAll()
  })

  it('holds a prompt sent before init and writes it once startup lands', async () => {
    const claude = fakeClaude({ initDelayMs: SLOW_INIT_MS })
    const { adapter } = startingAdapter(claude)
    await adapter.acquire(ACQUIRE)

    await expect(adapter.dispatch(PROMPT)).resolves.toEqual({ state: 'admitted' })
    expect(claude.connections[0].sent).toEqual([])

    await vi.advanceTimersByTimeAsync(SLOW_INIT_MS)
    await adapter.drainStartup('session-1')

    expect(claude.connections[0].sent).toHaveLength(1)
    expect(claude.connections[0].sent[0]).toMatchObject({ type: 'user' })
    await adapter.closeAll()
  })

  it('writes a prompt whose admission barrier was still running when startup landed', async () => {
    const claude = fakeClaude({ initDelayMs: SLOW_INIT_MS })
    const { adapter } = startingAdapter(claude)
    await adapter.acquire(ACQUIRE)
    let passBarrier = (): void => {}
    const barrier = new Promise<void>((resolve) => {
      passBarrier = resolve
    })

    const dispatched = adapter.dispatch({ ...PROMPT, beforeDispatch: () => barrier })
    await vi.advanceTimersByTimeAsync(SLOW_INIT_MS)
    await adapter.drainStartup('session-1')
    passBarrier()

    await expect(dispatched).resolves.toEqual({ state: 'admitted' })
    expect(claude.connections[0].sent.filter((message) => message.type === 'user')).toHaveLength(1)
    await adapter.closeAll()
  })

  it('ends the session with the exit reason when the CLI dies before init, and rejects held prompts', async () => {
    const claude = fakeClaude({
      initDelayMs: SLOW_INIT_MS,
      exitBeforeInit: 'claude stream-json exited (code 1): stderr says no'
    })
    const { adapter, events, late } = startingAdapter(claude)
    await adapter.acquire(ACQUIRE)
    await adapter.dispatch(PROMPT)

    await vi.advanceTimersByTimeAsync(SLOW_INIT_MS)
    await adapter.drainStartup('session-1')
    await adapter.drainObservedExits()

    expect(events.find((event) => event.type === 'ended')).toMatchObject({
      reason: 'claude stream-json exited (code 1): stderr says no',
      cause: 'unexpected-exit',
      startupUnproven: true
    })
    expect(late).toEqual([
      expect.objectContaining({ clientMessageId: 'client-1', state: 'rejected' })
    ])
    expect(claude.connections[0].sent).toEqual([])
    expect(claude.connections[0].closeCount).toBe(1)
  })

  it('ends a start whose root exit was seen first-hand even when its descendants are unverifiable', async () => {
    const claude = fakeClaude({
      initDelayMs: SLOW_INIT_MS,
      exitBeforeInit: 'claude stream-json exited (code 1): stderr says no',
      unprovenCloseVerdict: { root: 'exited', tree: 'unverifiable' }
    })
    const { adapter, events } = startingAdapter(claude)
    await adapter.acquire(ACQUIRE)

    await vi.advanceTimersByTimeAsync(SLOW_INIT_MS)
    await adapter.drainStartup('session-1')
    await adapter.drainObservedExits()

    // A failed start is released on the same evidence a failed create is.
    expect(events.find((event) => event.type === 'ended')).toMatchObject({
      cause: 'unexpected-exit',
      startupUnproven: true
    })
  })

  it('ends an unauthenticated start with sign-in guidance', async () => {
    const claude = fakeClaude({ initAccount: { apiProvider: 'firstParty', tokenSource: 'none' } })
    const { adapter, events } = startingAdapter(claude)
    await adapter.acquire(ACQUIRE)
    await adapter.drainStartup('session-1')
    await adapter.drainObservedExits()

    expect(events.find((event) => event.type === 'ended')).toMatchObject({
      reason: expect.stringMatching(/not signed in/),
      startupUnproven: true
    })
  })

  it('closes a session stopped before init without faulting it or writing held prompts', async () => {
    const claude = fakeClaude({ initDelayMs: SLOW_INIT_MS })
    const { adapter, events, late } = startingAdapter(claude)
    await adapter.acquire(ACQUIRE)
    await adapter.dispatch(PROMPT)

    await expect(adapter.closeSession('session-1')).resolves.toBe(true)
    await vi.advanceTimersByTimeAsync(SLOW_INIT_MS)
    await adapter.drainStartup('session-1')

    const connection = claude.connections[0]
    expect(connection.closeCount).toBe(1)
    expect(connection.sent).toEqual([])
    expect(connection.calls.map(({ subtype }) => subtype)).not.toContain('get_settings')
    expect(late).toEqual([
      expect.objectContaining({ clientMessageId: 'client-1', state: 'rejected' })
    ])
    expect(events.some((event) => event.type === 'ended' && event.startupUnproven)).toBe(false)
    expect(events.some((event) => event.type === 'started')).toBe(false)
  })

  it('withdraws a held prompt when the turn is cancelled before init', async () => {
    const claude = fakeClaude({ initDelayMs: SLOW_INIT_MS })
    const { adapter, late } = startingAdapter(claude)
    await adapter.acquire(ACQUIRE)
    await adapter.dispatch(PROMPT)

    await expect(
      adapter.cancelTurn({ sessionId: 'session-1', turnId: 'turn-1', fence: 7 })
    ).resolves.toEqual({ cancelled: true })
    await vi.advanceTimersByTimeAsync(SLOW_INIT_MS)
    await adapter.drainStartup('session-1')

    expect(claude.connections[0].sent).toEqual([])
    expect(late).toEqual([
      expect.objectContaining({ clientMessageId: 'client-1', state: 'rejected' })
    ])
    await adapter.closeAll()
  })

  it('withdraws the prompts still held when Stop lands while startup is writing them', async () => {
    const claude = fakeClaude({ initDelayMs: SLOW_INIT_MS })
    const { adapter, late } = startingAdapter(claude)
    await adapter.acquire(ACQUIRE)
    const connection = claude.connections[0]
    const send = connection.send
    let landFirstWrite = (): void => {}
    const firstWrite = new Promise<void>((resolve) => {
      landFirstWrite = resolve
    })
    let writes = 0
    connection.send = async (message, beforeDispatch) => {
      writes += 1
      if (writes === 1) {
        await firstWrite
      }
      return send(message, beforeDispatch)
    }
    await adapter.dispatch(PROMPT)
    await adapter.dispatch({ ...PROMPT, clientMessageId: 'client-2' })

    await vi.advanceTimersByTimeAsync(SLOW_INIT_MS)
    // Startup has landed and is writing the first held prompt.
    expect(writes).toBe(1)
    const cancelled = adapter.cancelTurn({ sessionId: 'session-1', turnId: 'turn-1', fence: 7 })
    await vi.advanceTimersByTimeAsync(0)
    landFirstWrite()
    await vi.advanceTimersByTimeAsync(5_000)
    await adapter.drainStartup('session-1')

    expect(connection.sent.filter((message) => message.type === 'user')).toHaveLength(1)
    expect(late).toContainEqual(
      expect.objectContaining({ clientMessageId: 'client-2', state: 'rejected' })
    )
    // Stop withdrew something, so it answers as a cancel whatever the interrupt made of the turn.
    await expect(cancelled).resolves.toEqual({ cancelled: true })
    await adapter.closeAll()
  })
})
