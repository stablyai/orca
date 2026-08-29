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

describe('OpenCode hook normalization', () => {
  it('SessionBusy maps to working', () => {
    const result = _internals.normalizeHookPayload(
      'opencode',
      buildBody({ hook_event_name: 'SessionBusy' }),
      'production'
    )
    expect(result?.payload.state).toBe('working')
    expect(result?.payload.agentType).toBe('opencode')
  })

  it('SessionBusy does NOT clear the cached user prompt', () => {
    // Why: OpenCode caches the user's MessagePart before SessionBusy fires, so the cached prompt is this turn's; clearing it would clobber the dashboard.
    _internals.normalizeHookPayload(
      'opencode',
      buildBody({ hook_event_name: 'MessagePart', role: 'user', text: 'new prompt' }),
      'production'
    )
    const result = _internals.normalizeHookPayload(
      'opencode',
      buildBody({ hook_event_name: 'SessionBusy' }),
      'production'
    )
    expect(result?.payload.state).toBe('working')
    expect(result?.payload.prompt).toBe('new prompt')
  })

  it('SessionIdle maps to done', () => {
    const result = _internals.normalizeHookPayload(
      'opencode',
      buildBody({ hook_event_name: 'SessionIdle' }),
      'production'
    )
    expect(result?.payload.state).toBe('done')
    expect(result?.payload.agentType).toBe('opencode')
  })

  it('PermissionRequest maps to waiting', () => {
    const result = _internals.normalizeHookPayload(
      'opencode',
      buildBody({ hook_event_name: 'PermissionRequest' }),
      'production'
    )
    expect(result?.payload.state).toBe('waiting')
  })

  it('AskUserQuestion maps to waiting', () => {
    // Why: AskUserQuestion leaves the agent idle-but-waiting on a human, so it must map to `waiting` (red dot) like permission.asked, not stay `working`.
    const result = _internals.normalizeHookPayload(
      'opencode',
      buildBody({ hook_event_name: 'AskUserQuestion' }),
      'production'
    )
    expect(result?.payload.state).toBe('waiting')
    expect(result?.payload.agentType).toBe('opencode')
  })

  it('unknown event name returns null', () => {
    const result = _internals.normalizeHookPayload(
      'opencode',
      buildBody({ hook_event_name: 'SomeOtherEvent' }),
      'production'
    )
    expect(result).toBeNull()
  })

  it('MessagePart with role=user surfaces text as the prompt and stays working', () => {
    const result = _internals.normalizeHookPayload(
      'opencode',
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
    expect(result?.promptInteractionKey).toBe('opencode-message-msg-1')
  })

  it('MessagePart with role=assistant populates lastAssistantMessage', () => {
    const result = _internals.normalizeHookPayload(
      'opencode',
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
      'opencode',
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
      'opencode',
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
      'opencode',
      buildBody({ hook_event_name: 'MessagePart', role: 'user', text: 'hi' }),
      'production'
    )
    _internals.normalizeHookPayload(
      'opencode',
      buildBody({ hook_event_name: 'MessagePart', role: 'assistant', text: 'hello back' }),
      'production'
    )
    const done = _internals.normalizeHookPayload(
      'opencode',
      buildBody({ hook_event_name: 'SessionIdle' }),
      'production'
    )
    expect(done?.payload.state).toBe('done')
    expect(done?.payload.prompt).toBe('hi')
    expect(done?.payload.lastAssistantMessage).toBe('hello back')
  })
})
