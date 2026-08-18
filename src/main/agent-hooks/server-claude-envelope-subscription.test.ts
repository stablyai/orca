import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from './server'
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

describe('AgentHookServer raw Claude proof envelopes', () => {
  it('publishes the authenticated SessionStart body before status normalization', async () => {
    const server = new AgentHookServer()
    const received: unknown[] = []
    const unsubscribe = server.subscribeClaudeHookEnvelopes((envelope) => received.push(envelope))
    await server.start({ env: 'production' })
    try {
      const env = server.buildPtyEnv()
      const body = buildBody(
        {
          hook_event_name: 'SessionStart',
          source: 'resume',
          session_id: 'claude-session',
          transcript_path: '/tmp/claude-session.jsonl'
        },
        { launchToken: 'claude-spawn-token' }
      )
      const response = await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/claude`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
        },
        body: JSON.stringify(body)
      })

      expect(response.status).toBe(204)
      expect(received).toEqual([body])
    } finally {
      unsubscribe()
      server.stop()
    }
  })
})
