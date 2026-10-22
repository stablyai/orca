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

const COMMAND = { command: 'rm -rf /tmp/orca-28186-permission-target' }

describe('Claude permission wait after the approved tool fails', () => {
  it('clears the wait when PostToolUseFailure names the waiting request', async () => {
    await withClaudeHookServer(async (post, server) => {
      await post({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: COMMAND,
        tool_use_id: 'toolu-approved'
      })
      await post({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: COMMAND })
      await post({
        hook_event_name: 'PostToolUseFailure',
        tool_name: 'Bash',
        tool_input: COMMAND,
        tool_use_id: 'toolu-approved',
        error: 'exit status 1'
      })

      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({ paneKey: PANE, state: 'working', agentType: 'claude' })
      ])
    })
  })

  it('keeps the wait when another tool use fails', async () => {
    await withClaudeHookServer(async (post, server) => {
      await post({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: COMMAND,
        tool_use_id: 'toolu-approved'
      })
      await post({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: COMMAND })
      await post({
        hook_event_name: 'PostToolUseFailure',
        tool_name: 'Read',
        tool_input: { file_path: '/tmp/other.txt' },
        tool_use_id: 'toolu-sibling',
        error: 'not found'
      })

      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({ paneKey: PANE, state: 'waiting', toolName: 'Bash' })
      ])
    })
  })

  it("keeps a lead's wait when a subagent's tool with the same id fails", async () => {
    await withClaudeHookServer(async (post, server) => {
      await post({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: COMMAND,
        tool_use_id: 'toolu-approved'
      })
      await post({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: COMMAND })
      await post({
        hook_event_name: 'PostToolUseFailure',
        tool_name: 'Bash',
        tool_input: COMMAND,
        tool_use_id: 'toolu-approved',
        agent_id: 'agent-child',
        agent_type: 'general-purpose',
        error: 'exit status 1'
      })

      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({ paneKey: PANE, state: 'waiting', toolName: 'Bash' })
      ])
    })
  })
})
