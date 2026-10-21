import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from './server'
import { buildBody, PANE } from './server.test-fixtures'

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
  vi.restoreAllMocks()
})

// Why: the order (and the late PostToolUse) is what codex-cli 0.159.3 posted live for Esc on an
// approval prompt, then Esc while `sleep 40` ran; the shell finished 24s after the Interrupt.
const TURN_1 = { session_id: 'session-1', turn_id: 'turn-1', model: 'gpt-5.5' }
const TURN_2 = { session_id: 'session-1', turn_id: 'turn-2', model: 'gpt-5.5' }
const BASH = { tool_name: 'Bash', tool_input: { command: 'sleep 40' }, tool_use_id: 'exec-2' }

describe("Codex's Interrupt hook through the status store", () => {
  let server: AgentHookServer
  let post: (payload: Record<string, unknown>) => Promise<void>

  beforeEach(async () => {
    server = new AgentHookServer()
    await server.start({ env: 'production' })
    const env = server.buildPtyEnv()
    post = async (payload) => {
      const response = await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/codex`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
        },
        body: JSON.stringify(buildBody(payload))
      })
      expect(response.status).toBe(204)
    }
  })

  afterEach(() => {
    server.stop()
  })

  function row(): ReturnType<AgentHookServer['getStatusSnapshot']>[number] | undefined {
    return server.getStatusSnapshot().find((entry) => entry.paneKey === PANE)
  }

  it('settles a declined approval and a cancelled tool, and holds the late tool result', async () => {
    await post({ ...TURN_1, hook_event_name: 'UserPromptSubmit', prompt: 'touch hello.txt' })
    await post({ ...TURN_1, ...BASH, hook_event_name: 'PreToolUse' })
    await post({ ...TURN_1, ...BASH, hook_event_name: 'PermissionRequest' })
    expect(row()?.state).toBe('waiting')

    await post({ ...TURN_1, hook_event_name: 'Interrupt', permission_mode: 'default' })
    expect(row()).toMatchObject({
      state: 'done',
      interrupted: true,
      mainAgent: { state: 'done', outcome: 'cancellation' }
    })

    await post({ ...TURN_2, hook_event_name: 'UserPromptSubmit', prompt: 'sleep 40' })
    await post({ ...TURN_2, ...BASH, hook_event_name: 'PreToolUse' })
    expect(row()?.state).toBe('working')

    await post({ ...TURN_2, hook_event_name: 'Interrupt', permission_mode: 'default' })
    expect(row()).toMatchObject({ state: 'done', interrupted: true })

    const lateBy = Date.now() + 24_000
    vi.spyOn(Date, 'now').mockReturnValue(lateBy)
    await post({ ...TURN_2, ...BASH, hook_event_name: 'PostToolUse', tool_response: '' })
    expect(row()).toMatchObject({
      state: 'done',
      mainAgent: { state: 'done', outcome: 'cancellation' }
    })
  })
})
