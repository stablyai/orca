import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_STATUS_MAX_SUBAGENTS } from '../../shared/agent-status-types'
import { AgentHookServer, _internals } from './server'
import { buildBody, PANE } from './server.test-fixtures'

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

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Claude child permission lifecycle', () => {
  async function createServer(): Promise<{
    server: AgentHookServer
    postClaudeHook: (payload: Record<string, unknown>) => Promise<Response>
  }> {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    const env = server.buildPtyEnv()
    return {
      server,
      postClaudeHook: (payload) =>
        fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/claude`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
          },
          body: JSON.stringify(buildBody(payload))
        })
    }
  }

  it('clears a child permission when that child stops', async () => {
    const { server, postClaudeHook } = await createServer()
    try {
      await postClaudeHook({ hook_event_name: 'UserPromptSubmit', prompt: 'guarded task' })
      await postClaudeHook({
        hook_event_name: 'PermissionRequest',
        agent_id: 'a-blocked',
        agent_type: 'general-purpose',
        tool_name: 'Bash',
        tool_input: { command: 'false' }
      })
      await postClaudeHook({ hook_event_name: 'SubagentStop', agent_id: 'a-other' })
      expect(server.getStatusSnapshot()[0]).toMatchObject({
        state: 'waiting',
        toolName: 'Bash',
        subagents: [expect.objectContaining({ id: 'a-blocked', state: 'working' })]
      })
      await postClaudeHook({ hook_event_name: 'SubagentStop', agent_id: 'a-blocked' })

      const status = server.getStatusSnapshot()[0]
      expect(status).toMatchObject({ paneKey: PANE, state: 'working', agentType: 'claude' })
      expect(status?.toolName).toBeUndefined()
      expect(status?.toolInput).toBeUndefined()
      expect(status?.interactivePrompt).toBeUndefined()
      expect(status?.subagents).toBeUndefined()
    } finally {
      server.stop()
    }
  })

  it('clears a teammate permission when that teammate idles', async () => {
    const { server, postClaudeHook } = await createServer()
    try {
      await postClaudeHook({ hook_event_name: 'UserPromptSubmit', prompt: 'guarded task' })
      await postClaudeHook({
        hook_event_name: 'PermissionRequest',
        agent_id: 'areviewer-6d3cb5b5',
        agent_type: 'reviewer',
        tool_name: 'Bash',
        tool_input: { command: 'false' }
      })
      await postClaudeHook({ hook_event_name: 'TeammateIdle', teammate_name: 'writer' })
      expect(server.getStatusSnapshot()[0]).toMatchObject({
        state: 'waiting',
        toolName: 'Bash',
        subagents: [expect.objectContaining({ id: 'areviewer-6d3cb5b5', state: 'working' })]
      })
      await postClaudeHook({ hook_event_name: 'TeammateIdle', teammate_name: 'reviewer' })

      const status = server.getStatusSnapshot()[0]
      expect(status).toMatchObject({
        paneKey: PANE,
        state: 'working',
        agentType: 'claude',
        subagents: [expect.objectContaining({ id: 'areviewer-6d3cb5b5', state: 'idle' })]
      })
      expect(status?.toolName).toBeUndefined()
      expect(status?.toolInput).toBeUndefined()
      expect(status?.interactivePrompt).toBeUndefined()
    } finally {
      server.stop()
    }
  })

  it('keeps a child permission after unrelated lead progress and teammate idle', async () => {
    const { server, postClaudeHook } = await createServer()
    try {
      await postClaudeHook({ hook_event_name: 'UserPromptSubmit', prompt: 'guarded task' })
      await postClaudeHook({
        hook_event_name: 'PermissionRequest',
        agent_id: 'areviewer-6d3cb5b5',
        agent_type: 'reviewer',
        tool_name: 'Bash',
        tool_input: { command: 'false' }
      })
      await postClaudeHook({ hook_event_name: 'PreToolUse', tool_name: 'Read' })
      await postClaudeHook({ hook_event_name: 'TeammateIdle', teammate_name: 'writer' })

      expect(server.getStatusSnapshot()[0]).toMatchObject({
        state: 'waiting',
        toolName: 'Bash',
        subagents: [expect.objectContaining({ id: 'areviewer-6d3cb5b5', state: 'working' })]
      })
    } finally {
      server.stop()
    }
  })

  it('clears an omitted teammate permission when a full roster excludes its row', async () => {
    const { server, postClaudeHook } = await createServer()
    try {
      await postClaudeHook({ hook_event_name: 'UserPromptSubmit', prompt: 'guarded task' })
      for (let index = 0; index < AGENT_STATUS_MAX_SUBAGENTS; index += 1) {
        await postClaudeHook({ hook_event_name: 'SubagentStart', agent_id: `acapped${index}` })
      }
      await postClaudeHook({
        hook_event_name: 'PermissionRequest',
        agent_id: 'areviewer-6d3cb5b5',
        agent_type: 'reviewer',
        tool_name: 'Bash',
        tool_input: { command: 'false' }
      })
      expect(server.getStatusSnapshot()[0]).toMatchObject({ state: 'waiting', toolName: 'Bash' })
      expect(server.getStatusSnapshot()[0]?.subagents).toHaveLength(AGENT_STATUS_MAX_SUBAGENTS)

      await postClaudeHook({ hook_event_name: 'TeammateIdle', teammate_name: 'reviewer' })

      const status = server.getStatusSnapshot()[0]
      expect(status).toMatchObject({ paneKey: PANE, state: 'working', agentType: 'claude' })
      expect(status?.toolName).toBeUndefined()
      expect(status?.toolInput).toBeUndefined()
      expect(status?.subagents).toHaveLength(AGENT_STATUS_MAX_SUBAGENTS)
    } finally {
      server.stop()
    }
  })
})
