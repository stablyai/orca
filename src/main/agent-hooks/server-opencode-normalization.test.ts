import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _internals } from './server'
import { buildBody } from './server.test-fixtures'

const { getCohortAtEmitMock, trackMock } = vi.hoisted(() => ({
  getCohortAtEmitMock: vi.fn(),
  trackMock: vi.fn()
}))

vi.mock('../telemetry/client', () => ({
  track: trackMock
}))

vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: getCohortAtEmitMock
}))

beforeEach(() => {
  _internals.resetCachesForTests()
  trackMock.mockReset()
  getCohortAtEmitMock.mockReset()
  getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe.each(['opencode', 'opencode2'] as const)('%s hook normalization', (source) => {
  it('SessionBusy maps to working', () => {
    const result = _internals.normalizeHookPayload(
      source,
      buildBody({ hook_event_name: 'SessionBusy' }),
      'production'
    )
    expect(result?.payload.state).toBe('working')
    expect(result?.payload.agentType).toBe(source)
  })

  it('SessionBusy does NOT clear the cached user prompt', () => {
    // Why: OpenCode caches the user's MessagePart before SessionBusy fires, so the cached prompt is this turn's; clearing it would clobber the dashboard.
    _internals.normalizeHookPayload(
      source,
      buildBody({ hook_event_name: 'MessagePart', role: 'user', text: 'new prompt' }),
      'production'
    )
    const result = _internals.normalizeHookPayload(
      source,
      buildBody({ hook_event_name: 'SessionBusy' }),
      'production'
    )
    expect(result?.payload.state).toBe('working')
    expect(result?.payload.prompt).toBe('new prompt')
  })

  it('SessionIdle maps to done', () => {
    const result = _internals.normalizeHookPayload(
      source,
      buildBody({ hook_event_name: 'SessionIdle' }),
      'production'
    )
    expect(result?.payload.state).toBe('done')
    expect(result?.payload.agentType).toBe(source)
  })

  it('PermissionRequest maps to waiting', () => {
    const result = _internals.normalizeHookPayload(
      source,
      buildBody({ hook_event_name: 'PermissionRequest' }),
      'production'
    )
    expect(result?.payload.state).toBe('waiting')
  })

  it('AskUserQuestion maps to waiting', () => {
    // Why: AskUserQuestion leaves the agent idle-but-waiting on a human, so it must map to `waiting` (red dot) like permission.asked, not stay `working`.
    const result = _internals.normalizeHookPayload(
      source,
      buildBody({ hook_event_name: 'AskUserQuestion' }),
      'production'
    )
    expect(result?.payload.state).toBe('waiting')
    expect(result?.payload.agentType).toBe(source)
  })

  it('unknown event name returns null', () => {
    const result = _internals.normalizeHookPayload(
      source,
      buildBody({ hook_event_name: 'SomeOtherEvent' }),
      'production'
    )
    expect(result).toBeNull()
  })

  it('MessagePart with role=user surfaces text as the prompt and stays working', () => {
    const result = _internals.normalizeHookPayload(
      source,
      buildBody({
        hook_event_name: 'MessagePart',
        role: 'user',
        text: 'hi there',
        messageID: 'msg-1'
      }),
      'production'
    )
    expect(result?.payload.state).toBe('working')
    expect(result?.payload.prompt).toBe('hi there')
    expect(result?.hasExplicitPrompt).toBe(true)
    expect(result?.promptInteractionKey).toBe(`${source}-message-msg-1`)
  })

  it('MessagePart with role=assistant populates lastAssistantMessage', () => {
    const result = _internals.normalizeHookPayload(
      source,
      buildBody({
        hook_event_name: 'MessagePart',
        role: 'assistant',
        text: 'Hello! How can I help?'
      }),
      'production'
    )
    expect(result?.payload.state).toBe('working')
    expect(result?.payload.lastAssistantMessage).toBe('Hello! How can I help?')
  })

  it('caps oversized MessagePart text from stale (pre-throttle) plugin builds', () => {
    // Why: stale plugin builds re-post the full reply on every part update, so the listener must cap the text to keep per-event work O(cap).
    const assistant = _internals.normalizeHookPayload(
      source,
      buildBody({
        hook_event_name: 'MessagePart',
        role: 'assistant',
        text: 'a'.repeat(500_000)
      }),
      'production'
    )
    expect(assistant?.payload.lastAssistantMessage?.length).toBe(8_000)

    // Why: prompt is capped at 200 by normalizeAgentStatusObject; assert oversized input still stays within that bound.
    const user = _internals.normalizeHookPayload(
      source,
      buildBody({
        hook_event_name: 'MessagePart',
        role: 'user',
        text: 'u'.repeat(500_000),
        messageID: 'msg-cap'
      }),
      'production'
    )
    expect(user?.payload.prompt?.length).toBe(200)
  })

  it('subsequent SessionIdle preserves cached prompt + assistant message', () => {
    _internals.normalizeHookPayload(
      source,
      buildBody({ hook_event_name: 'MessagePart', role: 'user', text: 'hi' }),
      'production'
    )
    _internals.normalizeHookPayload(
      source,
      buildBody({ hook_event_name: 'MessagePart', role: 'assistant', text: 'hello back' }),
      'production'
    )
    const done = _internals.normalizeHookPayload(
      source,
      buildBody({ hook_event_name: 'SessionIdle' }),
      'production'
    )
    expect(done?.payload.state).toBe('done')
    expect(done?.payload.prompt).toBe('hi')
    expect(done?.payload.lastAssistantMessage).toBe('hello back')
  })
})

describe('OpenCode main agent from the root session state', () => {
  function normalize(
    payload: Record<string, unknown>,
    source: 'opencode' | 'opencode2' | 'mimo-code' = 'opencode'
  ) {
    return _internals.normalizeHookPayload(source, buildBody(payload), 'production')?.payload
  }

  it.each([
    ['MessageOutputLengthError', 'failure'],
    ['ContentFilterError', 'failure'],
    ['ProviderAuthError', 'failure'],
    ['APIError', 'failure'],
    ['UnknownError', 'failure'],
    ['StructuredOutputError', 'failure'],
    ['ContextOverflowError', 'failure'],
    ['SomeFutureError', 'failure'],
    ['MessageAbortedError', 'cancellation'],
    [undefined, undefined],
    [42, undefined],
    ['', undefined]
  ])('an ended root turn named %s records %s', (name, outcome) => {
    const payload = normalize({
      hook_event_name: 'SessionIdle',
      root_state: 'done',
      ...(name === undefined ? {} : { root_turn_error_name: name })
    })
    expect(payload?.state).toBe('done')
    expect(payload?.mainAgent?.state).toBe('done')
    expect(payload?.mainAgent?.outcome).toBe(outcome)
    expect(payload?.interrupted).toBe(outcome === 'cancellation' ? true : undefined)
  })

  it('keeps the pane working when the root failed under a busy child', () => {
    const payload = normalize({
      hook_event_name: 'SessionBusy',
      root_state: 'done',
      root_turn_error_name: 'APIError'
    })
    expect(payload?.state).toBe('working')
    expect(payload?.mainAgent).toMatchObject({ state: 'done', outcome: 'failure' })
  })

  it('restates a cancellation under a busy child without marking the working row interrupted', () => {
    const payload = normalize({
      hook_event_name: 'SessionBusy',
      root_state: 'done',
      root_turn_error_name: 'MessageAbortedError'
    })
    expect(payload?.state).toBe('working')
    expect(payload?.mainAgent).toMatchObject({ state: 'done', outcome: 'cancellation' })
    expect(payload?.interrupted).toBeUndefined()
  })

  it('records no verdict on a root that is still working or waiting', () => {
    const working = normalize({
      hook_event_name: 'SessionBusy',
      root_state: 'working',
      root_turn_error_name: 'APIError'
    })
    expect(working?.mainAgent).toEqual({ state: 'working', stateStartedAt: expect.any(Number) })
    const waiting = normalize({ hook_event_name: 'AskUserQuestion', root_state: 'waiting' })
    expect(waiting?.state).toBe('waiting')
    expect(waiting?.mainAgent?.state).toBe('waiting')
  })

  it('publishes no main agent without a valid root state', () => {
    expect(normalize({ hook_event_name: 'SessionIdle' })?.mainAgent).toBeUndefined()
    const invalid = normalize({
      hook_event_name: 'SessionIdle',
      root_state: 'idle',
      root_turn_error_name: 'APIError'
    })
    expect(invalid?.mainAgent).toBeUndefined()
    const stalePart = normalize({ hook_event_name: 'MessagePart', role: 'assistant', text: 'hi' })
    expect(stalePart?.mainAgent).toBeUndefined()
  })

  it('honours the root state a MessagePart carries', () => {
    const payload = normalize({
      hook_event_name: 'MessagePart',
      role: 'assistant',
      text: 'streaming',
      root_state: 'working'
    })
    expect(payload?.state).toBe('working')
    expect(payload?.mainAgent?.state).toBe('working')
    const prompt = normalize({
      hook_event_name: 'MessagePart',
      role: 'user',
      text: 'next prompt',
      root_state: 'done'
    })
    expect(prompt?.mainAgent).toEqual({ state: 'done', stateStartedAt: expect.any(Number) })
  })

  it('starts a SessionStart main agent done, without a verdict', () => {
    const payload = normalize({
      hook_event_name: 'SessionStart',
      sessionID: 'fresh',
      root_state: 'done',
      root_turn_error_name: 'APIError'
    })
    expect(payload).toMatchObject({ state: 'done', sessionBoundary: true })
    expect(payload?.mainAgent).toEqual({ state: 'done', stateStartedAt: expect.any(Number) })
  })

  it.each(['opencode2', 'mimo-code'] as const)('publishes no main agent for %s', (source) => {
    const payload = normalize(
      { hook_event_name: 'SessionIdle', root_state: 'done', root_turn_error_name: 'APIError' },
      source
    )
    expect(payload?.state).toBe('done')
    expect(payload?.mainAgent).toBeUndefined()
    expect(payload?.interrupted).toBeUndefined()
  })

  describe('main agent clock', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    function normalizeAt(at: number, payload: Record<string, unknown>) {
      vi.setSystemTime(at)
      return normalize(payload)
    }

    it('keeps the root clock through child posts and restarts it at a session start', () => {
      normalizeAt(1_000, { hook_event_name: 'SessionBusy', root_state: 'working' })
      expect(
        normalizeAt(2_000, {
          hook_event_name: 'MessagePart',
          role: 'assistant',
          text: 'hi',
          root_state: 'working'
        })?.mainAgent
      ).toEqual({ state: 'working', stateStartedAt: 1_000 })

      normalizeAt(3_000, {
        hook_event_name: 'SessionBusy',
        root_state: 'done',
        root_turn_error_name: 'APIError'
      })
      expect(
        normalizeAt(4_000, {
          hook_event_name: 'SessionIdle',
          root_state: 'done',
          root_turn_error_name: 'APIError'
        })?.mainAgent
      ).toEqual({ state: 'done', outcome: 'failure', stateStartedAt: 3_000 })

      expect(
        normalizeAt(5_000, {
          hook_event_name: 'SessionStart',
          sessionID: 'next',
          root_state: 'done'
        })?.mainAgent
      ).toEqual({ state: 'done', stateStartedAt: 5_000 })
    })
  })
})
