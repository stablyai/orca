import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from './server'
import { createHookListenerState } from '../../shared/agent-hook-listener/listener-state'
import { normalizeHookPayload } from '../../shared/agent-hook-listener'
import type { AgentHookSource } from '../../shared/agent-hook-relay'
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
  getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// Why ingestRemote: SSH hook events land here with `hasExplicitPrompt` already carried by the
// relay envelope, and local events share the status timing it applies.
function relayedServer(source: AgentHookSource): {
  server: AgentHookServer
  send: (payload: Record<string, unknown>, at: number) => void
} {
  const server = new AgentHookServer()
  const state = createHookListenerState()
  return {
    server,
    send: (payload, at) => {
      vi.setSystemTime(at)
      const event = normalizeHookPayload(state, source, buildBody(payload), 'production')
      if (!event) {
        throw new Error('fixture was rejected')
      }
      server.ingestRemote(event, 'conn-1')
    }
  }
}

describe('explicitPromptStartedAt on the hook row', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('stays unset through a Copilot SessionStart, and is set by its UserPromptSubmit', () => {
    const { server, send } = relayedServer('copilot')
    send({ hook_event_name: 'SessionStart', session_id: 's-1' }, 1_000)
    expect(server.getStatusSnapshot()[0]).toMatchObject({ state: 'working', stateStartedAt: 1_000 })
    expect(server.getStatusSnapshot()[0].explicitPromptStartedAt).toBeUndefined()

    send({ hook_event_name: 'UserPromptSubmit', prompt: 'add a migration' }, 2_000)
    expect(server.getStatusSnapshot()[0]).toMatchObject({
      state: 'working',
      stateStartedAt: 1_000,
      explicitPromptStartedAt: 2_000
    })
  })

  it('is set by a Claude prompt submit and pinned for the rest of that turn', () => {
    const { server, send } = relayedServer('claude')
    send({ hook_event_name: 'UserPromptSubmit', prompt: 'fix the bug' }, 1_000)
    send({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }, 2_000)
    expect(server.getStatusSnapshot()[0]).toMatchObject({
      state: 'working',
      explicitPromptStartedAt: 1_000
    })
  })

  it('clears when the turn ends', () => {
    const { server, send } = relayedServer('claude')
    send({ hook_event_name: 'UserPromptSubmit', prompt: 'fix the bug' }, 1_000)
    send({ hook_event_name: 'Stop' }, 2_000)
    expect(server.getStatusSnapshot()[0].state).toBe('done')
    expect(server.getStatusSnapshot()[0].explicitPromptStartedAt).toBeUndefined()
  })
})
