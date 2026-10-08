import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeStructuredSessionAdapterDeps } from './claude-structured-session-adapter'
import type { ClaudeStructuredSessionEvent } from './claude-structured-session-state'
import {
  adapterAtPublishFor,
  fakeClaude,
  identityFor,
  USER_MESSAGE,
  claudeStartupSettled
} from './claude-structured-session-test-support'
import { CLAUDE_DEFAULT_REQUEST_TIMEOUT_MS } from './claude-agent-sdk-control-requests'

/** Far past any deadline a start used to have. */
const NEVER_MS = 10 * 60_000

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
    await claudeStartupSettled(adapter, 'session-1')

    expect(events.find((event) => event.type === 'options')).toMatchObject({
      models: [{ value: 'claude-sonnet' }]
    })
    expect(events.some((event) => event.type === 'ended')).toBe(false)
    expect(claude.connections[0].closeCount).toBe(0)
    await adapter.closeAll()
  })

  it('reports `started` with the options its child was launched with, having written none', async () => {
    const claude = fakeClaude({ initDelayMs: SLOW_INIT_MS, initModel: 'claude-opus-9' })
    const { adapter, events } = startingAdapter(claude)
    await adapter.acquire({ ...ACQUIRE, options: { model: 'opus' } })
    expect(claude.connections[0].launch.options.model).toBe('opus')
    expect(events.some((event) => event.type === 'started')).toBe(false)

    await vi.advanceTimersByTimeAsync(SLOW_INIT_MS)
    await claudeStartupSettled(adapter, 'session-1')

    const startedAt = events.findIndex((event) => event.type === 'started')
    expect(events[startedAt]).toEqual({
      type: 'started',
      sessionId: 'session-1',
      fence: 7,
      acquisitionGeneration: expect.any(String),
      // What the child was launched with, carried so the host never asks the CLI again.
      reportedOptions: expect.objectContaining({ model: 'opus' }),
      restoreSkippedOptions: []
    })
    expect(claude.connections[0].calls.map(({ subtype }) => subtype)).toEqual([
      'initialize',
      'get_settings'
    ])
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

  // The child was launched with the chat's saved options, so nothing waits on initialize: the SDK
  // streams the message to the CLI, which takes it behind its own start.
  it('writes a message sent before initialize answers at once', async () => {
    const claude = fakeClaude({ initDelayMs: SLOW_INIT_MS })
    const { adapter, events } = startingAdapter(claude)
    await adapter.acquire({ ...ACQUIRE, options: { model: 'opus' } })

    await expect(adapter.dispatch(PROMPT)).resolves.toEqual({ state: 'admitted' })
    expect(claude.connections[0].sent).toEqual([expect.objectContaining({ type: 'user' })])
    expect(events.some((event) => event.type === 'started')).toBe(false)

    await vi.advanceTimersByTimeAsync(SLOW_INIT_MS)
    await claudeStartupSettled(adapter, 'session-1')
    expect(events.some((event) => event.type === 'started')).toBe(true)
    await adapter.closeAll()
  })

  it('confirms a launched effort only when the settings readback reports that effort', async () => {
    const reportsHigh = {
      applied: { model: 'claude-sonnet-5', effort: 'high' },
      effective: { model: 'claude-sonnet-5', effortLevel: 'high', env: {} },
      sources: {}
    }
    const agreeing = fakeClaude({ settings: reportsHigh })
    const disagreeing = fakeClaude({ settings: reportsHigh })
    const started = async (claude: ReturnType<typeof fakeClaude>, effort: string) => {
      const { adapter } = startingAdapter(claude)
      await adapter.acquire({ ...ACQUIRE, options: { effort } })
      await claudeStartupSettled(adapter, 'session-1')
      return adapter
    }

    const kept = await started(agreeing, 'high')
    await expect(kept.readOptions({ sessionId: 'session-1', fence: 7 })).resolves.toMatchObject({
      current: { effort: 'high', confirmed: expect.arrayContaining(['effort']) }
    })
    // The saved pick stays wanted; only the readback could vouch for it, and it did not.
    const unconfirmed = await started(disagreeing, 'low')
    const options = await unconfirmed.readOptions({ sessionId: 'session-1', fence: 7 })
    expect(options.current.effort).toBe('low')
    expect(options.current.confirmed ?? []).not.toContain('effort')
    await kept.closeAll()
    await unconfirmed.closeAll()
  })

  // Measured on Claude Code 2.1.280: `--effort xhigh` reads back as `applied.effort: 'xhigh'` with
  // `effective` empty, since `effective` holds only the settings files.
  it('confirms a launched effort the CLI reports only as applied', async () => {
    const claude = fakeClaude({
      settings: { applied: { model: 'claude-opus-5', effort: 'xhigh' }, effective: {}, sources: {} }
    })
    const { adapter } = startingAdapter(claude)
    await adapter.acquire({ ...ACQUIRE, options: { effort: 'xhigh' } })
    await claudeStartupSettled(adapter, 'session-1')

    const options = await adapter.readOptions({ sessionId: 'session-1', fence: 7 })
    expect(options.current).toMatchObject({ effort: 'xhigh', confirmed: ['effort'] })
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
    await claudeStartupSettled(adapter, 'session-1')
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
    await claudeStartupSettled(adapter, 'session-1')
    await adapter.drainObservedExits()

    // A failed start is released on the same evidence a failed create is.
    expect(events.find((event) => event.type === 'ended')).toMatchObject({
      cause: 'unexpected-exit',
      startupUnproven: true
    })
  })

  it('lands a start whose CLI answers initialize only after minutes', async () => {
    const claude = fakeClaude({ initDelayMs: NEVER_MS - 1 })
    const { adapter, events } = startingAdapter(claude)
    await adapter.acquire(ACQUIRE)

    await vi.advanceTimersByTimeAsync(NEVER_MS)
    await claudeStartupSettled(adapter, 'session-1')

    expect(events.some((event) => event.type === 'started')).toBe(true)
    expect(events.some((event) => event.type === 'ended')).toBe(false)
    expect(claude.connections[0].closeCount).toBe(0)
    await adapter.closeAll()
  })

  // No deadline ends it: a Stop or a close does, and every message is already written meanwhile.
  it('keeps a start whose CLI never answers initialize, taking messages, until it is closed', async () => {
    const claude = fakeClaude({ initDelayMs: 10 * NEVER_MS })
    const { adapter, events } = startingAdapter(claude)
    await adapter.acquire(ACQUIRE)
    await expect(adapter.dispatch(PROMPT)).resolves.toEqual({ state: 'admitted' })

    await vi.advanceTimersByTimeAsync(NEVER_MS)

    expect(events.some((event) => event.type === 'ended' || event.type === 'started')).toBe(false)
    expect(claude.connections[0].closeCount).toBe(0)
    expect(claude.connections[0].sent).toEqual([expect.objectContaining({ type: 'user' })])
    await expect(adapter.closeSession('session-1')).resolves.toBe(true)
    expect(claude.connections[0].closeCount).toBe(1)
  })

  it('fails a start at once when a frame names another session before initialize answers', async () => {
    const claude = fakeClaude({ initDelayMs: NEVER_MS, initProof: 'none' })
    const { adapter, events } = startingAdapter(claude)
    await adapter.acquire(ACQUIRE)

    claude.connections[0].handlers.onMessage?.({
      type: 'system',
      subtype: 'hook_started',
      hook_name: 'SessionStart:startup',
      session_id: 'foreign-session'
    })
    await vi.advanceTimersByTimeAsync(0)
    await claudeStartupSettled(adapter, 'session-1')
    await adapter.drainObservedExits()

    expect(events.find((event) => event.type === 'ended')).toMatchObject({
      reason: 'claude provider session expected',
      failure: { kind: 'startFailed' },
      startupUnproven: true
    })
  })

  // Only a SessionStart hook sends a start frame before the first turn; without one, the
  // initialize answer is the whole start.
  it('lands a start whose CLI sends no start frame before its first turn', async () => {
    const claude = fakeClaude({ initProof: 'none' })
    const { adapter, events } = startingAdapter(claude)
    await adapter.acquire(ACQUIRE)
    await claudeStartupSettled(adapter, 'session-1')

    expect(events.some((event) => event.type === 'started')).toBe(true)
    await expect(adapter.dispatch(PROMPT)).resolves.toEqual({ state: 'admitted' })
    expect(claude.connections[0].sent).toEqual([expect.objectContaining({ type: 'user' })])
    await adapter.closeAll()
  })

  it('ends a started session whose first frame names another provider session', async () => {
    const claude = fakeClaude({ initProof: 'none' })
    const { adapter, events } = startingAdapter(claude)
    await adapter.acquire(ACQUIRE)
    await claudeStartupSettled(adapter, 'session-1')

    claude.connections[0].handlers.onMessage?.({
      type: 'system',
      subtype: 'init',
      session_id: 'foreign-session'
    })
    await adapter.drainObservedExits()

    expect(events.find((event) => event.type === 'ended')).toMatchObject({
      reason: 'claude provider session expected',
      cause: 'unexpected-exit'
    })
    expect(claude.connections[0].closeCount).toBe(1)
  })

  it('ends an unauthenticated start with sign-in guidance', async () => {
    const claude = fakeClaude({ initAccount: { apiProvider: 'firstParty', tokenSource: 'none' } })
    const { adapter, events } = startingAdapter(claude)
    await adapter.acquire(ACQUIRE)
    await claudeStartupSettled(adapter, 'session-1')
    await adapter.drainObservedExits()

    expect(events.find((event) => event.type === 'ended')).toMatchObject({
      reason: expect.stringMatching(/not signed in/),
      startupUnproven: true
    })
  })

  // Accounts as Claude 2.1.280 reports them at initialize; the /login key row is from its source.
  it.each([
    ['an ANTHROPIC_API_KEY', { tokenSource: 'none', apiKeySource: 'ANTHROPIC_API_KEY' }],
    ['a Console /login key', { tokenSource: 'none', apiKeySource: '/login managed key' }],
    ['an apiKeyHelper', { tokenSource: 'apiKeyHelper', apiKeySource: 'apiKeyHelper' }],
    ['an ANTHROPIC_AUTH_TOKEN', { tokenSource: 'ANTHROPIC_AUTH_TOKEN' }],
    ['a third-party provider', { apiProvider: 'bedrock' }]
  ])('starts a session Claude authenticates with %s', async (_label, account) => {
    const claude = fakeClaude({ initAccount: { apiProvider: 'firstParty', ...account } })
    const { adapter, events } = startingAdapter(claude)
    await adapter.acquire(ACQUIRE)
    await claudeStartupSettled(adapter, 'session-1')

    expect(events.some((event) => event.type === 'started')).toBe(true)
    expect(events.some((event) => event.type === 'ended')).toBe(false)
    await adapter.closeAll()
  })

  it('still refuses a start whose API key source is reported as none', async () => {
    const claude = fakeClaude({
      initAccount: { apiProvider: 'firstParty', tokenSource: 'none', apiKeySource: 'none' }
    })
    const { adapter, events } = startingAdapter(claude)
    await adapter.acquire(ACQUIRE)
    await claudeStartupSettled(adapter, 'session-1')
    await adapter.drainObservedExits()

    expect(events.find((event) => event.type === 'ended')).toMatchObject({
      reason: expect.stringMatching(/not signed in/)
    })
  })

  // A Stop that closes a child still starting must end the wait an option write is in, though
  // initialize never answers.
  it('ends the wait on a start closed before init, without faulting it', async () => {
    const claude = fakeClaude({ initDelayMs: 10 * SLOW_INIT_MS })
    const { adapter, events } = startingAdapter(claude)
    await adapter.acquire(ACQUIRE)
    let ended = false
    const waited = claudeStartupSettled(adapter, 'session-1').then(() => {
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

  // The CLI answers no control request before initialize; Claude's Stop ends the child instead.
  it('sends no interrupt to a CLI still starting, though it was handed a message', async () => {
    const claude = fakeClaude({ initDelayMs: SLOW_INIT_MS })
    const { adapter } = startingAdapter(claude)
    await adapter.acquire(ACQUIRE)
    await adapter.dispatch(PROMPT)

    await expect(adapter.cancelTurn({ sessionId: 'session-1', fence: 7 })).resolves.toEqual({
      cancelled: false
    })

    expect(claude.connections[0].calls.map(({ subtype }) => subtype)).not.toContain('interrupt')
    expect(adapter.stopEndsSession()).toBe(true)
    await adapter.closeAll()
  })
})
