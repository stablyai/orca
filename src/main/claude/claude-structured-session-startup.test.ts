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
    await adapter.awaitStarted('session-1')

    expect(events.find((event) => event.type === 'options')).toMatchObject({
      models: [{ value: 'claude-sonnet' }]
    })
    expect(events.some((event) => event.type === 'ended')).toBe(false)
    expect(claude.connections[0].closeCount).toBe(0)
    await adapter.closeAll()
  })

  it('reports `started` once saved options are restored, having written no prompt of its own', async () => {
    const claude = fakeClaude({ initDelayMs: SLOW_INIT_MS, initModel: 'claude-opus-9' })
    const { adapter, events } = startingAdapter(claude)
    const order: string[] = []
    claude.routes.set_model = () => {
      order.push('set_model')
      return undefined
    }
    await adapter.acquire({ ...ACQUIRE, options: { model: 'opus' } })
    expect(events.some((event) => event.type === 'started')).toBe(false)

    await vi.advanceTimersByTimeAsync(SLOW_INIT_MS)
    await adapter.awaitStarted('session-1')

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
    // The restore wrote the saved model before `started`; no message waits inside the adapter.
    expect(order).toEqual(['set_model'])
    expect(claude.connections[0].sent).toEqual([])
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

  // The host's delivery loop waits here before it hands a message over, so the adapter no longer
  // holds prompts of its own: nothing is written until startup lands because nothing is sent.
  it('resolves awaitStarted only once startup lands', async () => {
    const claude = fakeClaude({ initDelayMs: SLOW_INIT_MS })
    const { adapter } = startingAdapter(claude)
    await adapter.acquire(ACQUIRE)
    let started = false
    const waited = adapter.awaitStarted('session-1').then(() => {
      started = true
    })

    await vi.advanceTimersByTimeAsync(SLOW_INIT_MS - 1)
    expect(started).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await waited

    await expect(adapter.dispatch(PROMPT)).resolves.toEqual({ state: 'admitted' })
    expect(claude.connections[0].sent).toEqual([expect.objectContaining({ type: 'user' })])
    await adapter.closeAll()
  })

  it('ends the session with the exit reason when the CLI dies before init', async () => {
    const claude = fakeClaude({
      initDelayMs: SLOW_INIT_MS,
      exitBeforeInit: 'claude stream-json exited (code 1): stderr says no'
    })
    const { adapter, events } = startingAdapter(claude)
    await adapter.acquire(ACQUIRE)

    await vi.advanceTimersByTimeAsync(SLOW_INIT_MS)
    await adapter.awaitStarted('session-1')
    await adapter.drainObservedExits()

    expect(events.find((event) => event.type === 'ended')).toMatchObject({
      reason: 'claude stream-json exited (code 1): stderr says no',
      cause: 'unexpected-exit',
      startupUnproven: true
    })
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
    await adapter.awaitStarted('session-1')
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
    await adapter.awaitStarted('session-1')
    await adapter.drainObservedExits()

    expect(events.find((event) => event.type === 'ended')).toMatchObject({
      reason: expect.stringMatching(/not signed in/),
      startupUnproven: true
    })
  })

  // A Stop that closes a child still starting must end the wait the host's delivery loop is in,
  // though initialize never answers; otherwise every later send joins a loop that never moves.
  it('ends the wait on a start closed before init, without faulting it', async () => {
    const claude = fakeClaude({ initDelayMs: 10 * SLOW_INIT_MS })
    const { adapter, events } = startingAdapter(claude)
    await adapter.acquire(ACQUIRE)
    let ended = false
    const waited = adapter.awaitStarted('session-1').then(() => {
      ended = true
    })

    await expect(adapter.closeSession('session-1')).resolves.toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    await waited

    expect(ended).toBe(true)
    const connection = claude.connections[0]
    expect(connection.closeCount).toBe(1)
    expect(connection.sent).toEqual([])
    expect(connection.calls.map(({ subtype }) => subtype)).not.toContain('get_settings')
    expect(events.some((event) => event.type === 'ended' && event.startupUnproven)).toBe(false)
    expect(events.some((event) => event.type === 'started')).toBe(false)
  })

  it('interrupts nothing when Stop lands before init: nothing was written', async () => {
    const claude = fakeClaude({ initDelayMs: SLOW_INIT_MS })
    const { adapter } = startingAdapter(claude)
    await adapter.acquire(ACQUIRE)

    await expect(
      adapter.cancelTurn({ sessionId: 'session-1', turnId: 'turn-1', fence: 7 })
    ).resolves.toEqual({ cancelled: false })

    expect(claude.connections[0].calls.map(({ subtype }) => subtype)).not.toContain('interrupt')
    expect(claude.connections[0].sent).toEqual([])
    await adapter.closeAll()
  })
})
