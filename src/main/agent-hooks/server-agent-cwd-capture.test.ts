import { beforeEach, describe, expect, it } from 'vitest'
import { _internals } from './server'
import { buildBody } from './server.test-fixtures'

const AGENT_SUBDIRECTORY = '/repo/wt-1/packages/api'

beforeEach(() => {
  _internals.resetCachesForTests()
})

describe('agent working directory capture from hook payloads (STA-5804)', () => {
  it('captures the cwd a hand-started Claude session reports', () => {
    const event = _internals.normalizeHookPayload(
      'claude',
      buildBody({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'claude-session-1',
        cwd: AGENT_SUBDIRECTORY,
        prompt: 'fix the parser'
      }),
      'production'
    )

    expect(event?.providerSession).toEqual({ key: 'session_id', id: 'claude-session-1' })
    expect(event?.agentCwd).toBe(AGENT_SUBDIRECTORY)
  })

  it('captures the cwd a hand-started Codex session reports', () => {
    const event = _internals.normalizeHookPayload(
      'codex',
      buildBody({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'codex-session-1',
        cwd: AGENT_SUBDIRECTORY,
        prompt: 'fix the parser'
      }),
      'production'
    )

    expect(event?.providerSession).toEqual({ key: 'session_id', id: 'codex-session-1' })
    expect(event?.agentCwd).toBe(AGENT_SUBDIRECTORY)
  })

  it('leaves the directory unset when the payload reports none', () => {
    const event = _internals.normalizeHookPayload(
      'claude',
      buildBody({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'claude-session-1',
        prompt: 'fix the parser'
      }),
      'production'
    )

    expect(event?.providerSession).toEqual({ key: 'session_id', id: 'claude-session-1' })
    expect(event?.agentCwd).toBeUndefined()
  })

  it('leaves the directory unset when the payload reports a relative one', () => {
    const event = _internals.normalizeHookPayload(
      'claude',
      buildBody({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'claude-session-1',
        cwd: 'packages/api',
        prompt: 'fix the parser'
      }),
      'production'
    )

    expect(event?.agentCwd).toBeUndefined()
  })
})
