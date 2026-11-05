import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from './server'
import { buildBody, PANE } from './server.test-fixtures'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))

beforeEach(() => {
  _internals.resetCachesForTests()
})

afterEach(() => {
  vi.restoreAllMocks()
})

async function withClaudeHookServer(
  run: (
    post: (payload: Record<string, unknown>) => Promise<void>,
    server: AgentHookServer
  ) => Promise<void>
): Promise<void> {
  const server = new AgentHookServer()
  await server.start({ env: 'production' })
  try {
    const env = server.buildPtyEnv()
    await run(async (payload) => {
      const response = await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/claude`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
        },
        body: JSON.stringify(buildBody(payload))
      })
      expect(response.status).toBe(204)
    }, server)
  } finally {
    server.stop()
  }
}

const DENIED = { command: 'rm -rf /tmp/orca-denied-target' }
const RETRIED = { command: 'rm -rf /tmp/orca-retried-target' }

describe('Claude permission wait after a PermissionRequest hook denies', () => {
  // A PermissionRequest hook deny fires no PostToolUse, so the first wait is never settled.
  it('clears the wait when the retried request is approved', async () => {
    await withClaudeHookServer(async (post, server) => {
      await post({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: DENIED,
        tool_use_id: 'toolu-denied'
      })
      await post({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: DENIED })
      await post({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: RETRIED,
        tool_use_id: 'toolu-retried'
      })
      await post({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: RETRIED })
      expect(server.getStatusSnapshot()[0]).toMatchObject({ state: 'waiting', toolName: 'Bash' })
      await post({
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: RETRIED,
        tool_use_id: 'toolu-retried'
      })

      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({ paneKey: PANE, state: 'working', agentType: 'claude' })
      ])
    })
  })
})
