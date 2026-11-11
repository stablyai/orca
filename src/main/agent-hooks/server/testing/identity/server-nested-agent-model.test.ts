import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from '../../agent-hook-server'
import { buildBody, postHookEvent } from '../server.test-fixtures'

vi.mock('../../../../telemetry/client', () => ({
  track: vi.fn()
}))

vi.mock('../../../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn(() => ({ nth_repo_added: 2 }))
}))

beforeEach(() => {
  _internals.resetCachesForTests()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('AgentHookServer nested agent model fence', () => {
  // Readers retain sparse model labels, so a transient child label could remain on the parent.
  it('never pushes a nested codex model to the renderer from real hook bodies', async () => {
    vi.useRealTimers()
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    const pushed: { agentType?: string; model?: string }[] = []
    server.setListener((event) => pushed.push(event.payload))
    try {
      const steps: [string, Record<string, unknown>][] = [
        ['/hook/claude', { hook_event_name: 'UserPromptSubmit', session_id: 'c-1', prompt: 'p' }],
        [
          '/hook/codex',
          {
            hook_event_name: 'SessionStart',
            session_id: 'x-1',
            model: 'gpt-6-astra',
            source: 'startup'
          }
        ],
        [
          '/hook/codex',
          {
            hook_event_name: 'UserPromptSubmit',
            session_id: 'x-1',
            prompt: 'n',
            model: 'gpt-6-astra'
          }
        ],
        [
          '/hook/codex',
          {
            hook_event_name: 'PreToolUse',
            session_id: 'x-1',
            model: 'gpt-6-astra',
            tool_name: 'shell'
          }
        ],
        [
          '/hook/codex',
          {
            hook_event_name: 'Stop',
            session_id: 'x-1',
            model: 'gpt-6-astra',
            stop_hook_active: false
          }
        ],
        ['/hook/claude', { hook_event_name: 'Stop', session_id: 'c-1' }]
      ]
      for (const [path, body] of steps) {
        expect((await postHookEvent(server, buildBody(body), path)).status).toBe(204)
      }
      const [row] = server.getStatusSnapshot()
      expect(row).toMatchObject({ agentType: 'claude', state: 'done' })
      expect(row?.model).toBeUndefined()
    } finally {
      server.stop()
    }

    expect(pushed).toHaveLength(2)
    expect(pushed.every((payload) => payload.agentType === 'claude')).toBe(true)
    expect(pushed.map((payload) => payload.model)).not.toContain('gpt-6-astra')
  })
})
