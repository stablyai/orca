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

const COMMAND = { command: 'f=$(ls -d /mnt/*/sync.toml); for x in ${(f)f}; do cat $x; done' }

async function postDeniedPermission(
  post: (payload: Record<string, unknown>) => Promise<void>
): Promise<void> {
  await post({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: COMMAND,
    tool_use_id: 'toolu-denied'
  })
  await post({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: COMMAND })
}

// Claude's safety check can deny an unanswered prompt without PostToolUse(Failure) for that call.
describe('Claude permission wait denied without a tool result hook', () => {
  it('clears the wait once the lead batch resolves and the turn moves on', async () => {
    await withClaudeHookServer(async (post, server) => {
      await postDeniedPermission(post)
      expect(server.getStatusSnapshot()[0]).toMatchObject({ state: 'waiting', toolName: 'Bash' })

      await post({
        hook_event_name: 'PostToolBatch',
        tool_calls: [{ tool_name: 'Bash', tool_input: COMMAND, tool_use_id: 'toolu-denied' }]
      })
      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({ paneKey: PANE, state: 'working', agentType: 'claude' })
      ])

      await post({
        hook_event_name: 'PreToolUse',
        tool_name: 'Read',
        tool_input: { file_path: '/tmp/next.txt' },
        tool_use_id: 'toolu-next'
      })
      expect(server.getStatusSnapshot()[0]).toMatchObject({ state: 'working', toolName: 'Read' })
    })
  })

  it("keeps a lead's wait when only a subagent's batch resolves", async () => {
    await withClaudeHookServer(async (post, server) => {
      await postDeniedPermission(post)
      await post({
        hook_event_name: 'PostToolBatch',
        agent_id: 'agent-child',
        agent_type: 'general-purpose',
        tool_calls: [{ tool_name: 'Read', tool_input: {}, tool_use_id: 'toolu-child' }]
      })

      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({ paneKey: PANE, state: 'waiting', toolName: 'Bash' })
      ])
    })
  })
})
