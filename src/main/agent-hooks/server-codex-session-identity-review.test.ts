import { describe, expect, it, vi } from 'vitest'
import { normalizeHookPayload } from '../../shared/agent-hook-listener'
import { createHookListenerState } from '../../shared/agent-hook-listener/listener-state'
import { PANE_KEY } from '../../shared/agent-hook-listener-test-harness'
import { AgentHookServer } from './server'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn(() => ({})) }))

describe('review: Codex root identity isolation', () => {
  it('keeps the parent status and session when a child emits SessionStart', () => {
    const state = createHookListenerState()
    const parent = normalizeHookPayload(
      state,
      'codex',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'UserPromptSubmit',
          prompt: 'parent work',
          session_id: 'parent-session'
        }
      },
      'production'
    )
    if (!parent) {
      throw new Error('missing parent fixture')
    }
    state.lastStatusByPaneKey.set(PANE_KEY, parent)
    normalizeHookPayload(
      state,
      'codex',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'SessionStart',
          agent_id: 'child-agent',
          session_id: 'child-session'
        }
      },
      'production'
    )
    expect.soft(state.lastStatusByPaneKey.get(PANE_KEY)).toBe(parent)
    expect.soft(state.lastProviderSessionByPaneKey.get(PANE_KEY)?.id).toBe('parent-session')
    const next = normalizeHookPayload(
      state,
      'codex',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'PostToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'pwd' }
        }
      },
      'production'
    )
    expect.soft(next?.providerSession?.id).toBe('parent-session')
  })

  it('does not replace the current connection session with a delayed foreign SessionStart', () => {
    const server = new AgentHookServer()
    server.ingestRemote(
      {
        paneKey: PANE_KEY,
        source: 'codex',
        hookEventName: 'SessionStart',
        providerSession: { key: 'session_id', id: 'current-session' },
        payload: { agentType: 'codex', state: 'working', prompt: '' }
      },
      'current-connection'
    )
    server.ingestRemote(
      {
        paneKey: PANE_KEY,
        source: 'codex',
        hookEventName: 'UserPromptSubmit',
        providerSession: { key: 'session_id', id: 'current-session' },
        payload: { agentType: 'codex', state: 'working', prompt: 'current work' }
      },
      'current-connection'
    )
    server.ingestRemote(
      {
        paneKey: PANE_KEY,
        source: 'codex',
        hookEventName: 'SessionStart',
        providerSession: { key: 'session_id', id: 'stale-session' },
        payload: { agentType: 'codex', state: 'working', prompt: '' }
      },
      'stale-connection'
    )
    expect
      .soft(server.getStatusSnapshot())
      .toEqual([
        expect.objectContaining({ connectionId: 'current-connection', prompt: 'current work' })
      ])
    expect
      .soft(server._getStateForTests().lastProviderSessionByPaneKey.get(PANE_KEY)?.id)
      .toBe('current-session')
  })

  it('ignores session identity from an unrecognized hook', () => {
    const state = createHookListenerState()
    normalizeHookPayload(
      state,
      'codex',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'UserPromptSubmit',
          prompt: 'real work',
          session_id: 'real-session'
        }
      },
      'production'
    )
    const ignored = normalizeHookPayload(
      state,
      'codex',
      {
        paneKey: PANE_KEY,
        payload: { hook_event_name: 'UnknownEvent', session_id: 'ignored-session' }
      },
      'production'
    )
    expect(ignored).toBeNull()
    const next = normalizeHookPayload(
      state,
      'codex',
      {
        paneKey: PANE_KEY,
        payload: { hook_event_name: 'PostToolUse', tool_name: 'Bash' }
      },
      'production'
    )
    expect(next?.providerSession?.id).toBe('real-session')
  })
})
