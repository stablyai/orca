// Grok 1.0.70: Esc never cancels and Ctrl+C can open a stop dialog; only StopCancelled reports a cancel.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from './server'
import { buildBody, PANE } from './server.test-fixtures'
import type { AgentInterruptInputIntent } from '../../shared/agent-interrupt-intent'

const { getCohortAtEmitMock, trackMock } = vi.hoisted(() => ({
  getCohortAtEmitMock: vi.fn(),
  trackMock: vi.fn()
}))

vi.mock('../telemetry/client', () => ({ track: trackMock }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: getCohortAtEmitMock }))

beforeEach(() => {
  _internals.resetCachesForTests()
  trackMock.mockReset()
  getCohortAtEmitMock.mockReset()
  getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
})

afterEach(() => vi.restoreAllMocks())

async function postGrokHook(
  server: AgentHookServer,
  payload: Record<string, unknown>
): Promise<void> {
  const env = server.buildPtyEnv()
  const response = await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/grok`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
    },
    body: JSON.stringify(buildBody({ sessionId: 'session-1', ...payload }))
  })
  expect(response.status).toBe(204)
}

function row(server: AgentHookServer) {
  const entry = server.getStatusSnapshotForPane(PANE)[0]
  if (!entry) {
    throw new Error('the pane has no row')
  }
  return entry
}

function press(server: AgentHookServer, intent: AgentInterruptInputIntent): boolean {
  const baseline = row(server)
  return server.inferInterrupt({
    paneKey: PANE,
    baselineUpdatedAt: baseline.receivedAt,
    baselineStateStartedAt: baseline.stateStartedAt,
    baselinePrompt: baseline.prompt,
    baselineAgentType: 'grok',
    intent
  })
}

describe('a Grok keypress never decides a cancel', () => {
  it('refuses Esc and Ctrl+C on a working Grok turn', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      await postGrokHook(server, {
        hookEventName: 'user_prompt_submit',
        promptId: 'prompt-1',
        prompt: 'run the tests'
      })
      const working = row(server)
      expect(working).toMatchObject({ state: 'working', mainAgent: { state: 'working' } })

      expect(press(server, 'plain-escape')).toBe(false)
      expect(press(server, 'ctrl-c')).toBe(false)
      expect(row(server)).toEqual(working)
    } finally {
      server.stop()
    }
  })
})
