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

  it('clears a child permission when an API error ends that child', async () => {
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
      // Why: the lead's own progress while the child waits must not dismiss the child's card.
      await postClaudeHook({ hook_event_name: 'PreToolUse', tool_name: 'Read' })
      await postClaudeHook({
        hook_event_name: 'StopFailure',
        agent_id: 'a-other',
        error: 'rate_limit'
      })
      expect(server.getStatusSnapshot()[0]).toMatchObject({ state: 'waiting', toolName: 'Bash' })

      await postClaudeHook({
        hook_event_name: 'StopFailure',
        agent_id: 'a-blocked',
        agent_type: 'general-purpose',
        error: 'rate_limit'
      })

      const status = server.getStatusSnapshot()[0]
      expect(status).toMatchObject({ paneKey: PANE, state: 'working', agentType: 'claude' })
      // Why: the card's tool is dropped with the wait; the main agent's next hook names its own.
      expect(status?.toolName).toBeUndefined()
      expect(status?.interactivePrompt).toBeUndefined()
      expect(status?.subagents).toBeUndefined()
    } finally {
      server.stop()
    }
  })

  it('settles a finished lead when its background child fails on a pending permission', async () => {
    const { server, postClaudeHook } = await createServer()
    try {
      await postClaudeHook({
        hook_event_name: 'UserPromptSubmit',
        prompt: 'research in background'
      })
      await postClaudeHook({
        hook_event_name: 'SubagentStart',
        agent_id: 'a6324370b7bede0c7',
        agent_type: 'general-purpose'
      })
      await postClaudeHook({
        hook_event_name: 'Stop',
        last_assistant_message: 'Started the research.',
        background_tasks: [{ id: 'a6324370b7bede0c7', type: 'subagent', status: 'running' }]
      })
      await postClaudeHook({
        hook_event_name: 'PermissionRequest',
        agent_id: 'a6324370b7bede0c7',
        agent_type: 'general-purpose',
        tool_name: 'Bash',
        tool_input: { command: 'false' }
      })
      expect(server.getStatusSnapshot()[0]).toMatchObject({ state: 'waiting', toolName: 'Bash' })

      await postClaudeHook({
        hook_event_name: 'StopFailure',
        agent_id: 'a6324370b7bede0c7',
        agent_type: 'general-purpose',
        error: 'rate_limit'
      })

      const status = server.getStatusSnapshot()[0]
      expect(status).toMatchObject({ paneKey: PANE, state: 'done', agentType: 'claude' })
      expect(status?.interactivePrompt).toBeUndefined()
      expect(status?.subagents).toBeUndefined()
    } finally {
      server.stop()
    }
  })

  describe('at a main agent turn end', () => {
    const TURN = { prompt_id: '00000000-0000-4000-8000-000000000001' }
    const CHILD_ID = 'a6324370b7bede0c7'

    async function raiseChildPrompt(
      postClaudeHook: (payload: Record<string, unknown>) => Promise<Response>
    ): Promise<void> {
      await postClaudeHook({ ...TURN, hook_event_name: 'UserPromptSubmit', prompt: 'research' })
      await postClaudeHook({ ...TURN, hook_event_name: 'SubagentStart', agent_id: CHILD_ID })
      await postClaudeHook({
        ...TURN,
        hook_event_name: 'PermissionRequest',
        agent_id: CHILD_ID,
        agent_type: 'general-purpose',
        tool_name: 'Bash',
        tool_input: { command: 'false' }
      })
    }

    it('keeps a child permission while the Stop inventory lists that child running', async () => {
      const { server, postClaudeHook } = await createServer()
      try {
        await raiseChildPrompt(postClaudeHook)
        await postClaudeHook({
          ...TURN,
          hook_event_name: 'Stop',
          background_tasks: [{ id: CHILD_ID, type: 'subagent', status: 'running' }]
        })

        expect(server.getStatusSnapshot()[0]).toMatchObject({
          state: 'waiting',
          toolName: 'Bash',
          mainAgent: { state: 'done' }
        })
      } finally {
        server.stop()
      }
    })

    // Why: the child's own end went unobserved (a dropped hook); the inventory is the only evidence left.
    it('clears a child permission once the Stop inventory shows that child finished', async () => {
      const { server, postClaudeHook } = await createServer()
      try {
        await raiseChildPrompt(postClaudeHook)
        await postClaudeHook({
          ...TURN,
          hook_event_name: 'Stop',
          background_tasks: [{ id: CHILD_ID, type: 'subagent', status: 'completed' }]
        })

        const status = server.getStatusSnapshot()[0]
        expect(status).toMatchObject({ state: 'done', agentType: 'claude' })
        expect(status?.interactivePrompt).toBeUndefined()
        expect(status?.subagents).toBeUndefined()
      } finally {
        server.stop()
      }
    })

    // Why: the retired child's card must not ride on another owner's work; main cleared it when that work ended.
    it('clears a retired child permission at the Stop while another child keeps working', async () => {
      const { server, postClaudeHook } = await createServer()
      try {
        await raiseChildPrompt(postClaudeHook)
        await postClaudeHook({ ...TURN, hook_event_name: 'SubagentStart', agent_id: 'aother' })
        await postClaudeHook({
          ...TURN,
          hook_event_name: 'Stop',
          background_tasks: [
            { id: CHILD_ID, type: 'subagent', status: 'completed' },
            { id: 'aother', type: 'subagent', status: 'running' }
          ]
        })
        expect(server.getStatusSnapshot()[0]).toMatchObject({
          state: 'working',
          mainAgent: { state: 'done' }
        })

        await postClaudeHook({ ...TURN, hook_event_name: 'SubagentStop', agent_id: 'aother' })
        expect(server.getStatusSnapshot()[0]).toMatchObject({ state: 'done' })
      } finally {
        server.stop()
      }
    })

    const RETIRED_CHILD = { id: CHILD_ID, type: 'subagent', status: 'completed' }
    it.each([
      [
        'a background shell',
        { background_tasks: [RETIRED_CHILD, { id: 'b1', type: 'local_bash', status: 'running' }] }
      ],
      [
        'a session cron',
        { background_tasks: [RETIRED_CHILD], session_crons: [{ id: 'c1', cron: '*/5 * * * *' }] }
      ]
    ])(
      'clears a retired child permission at the Stop while %s keeps the pane working',
      async (_work, liveWork) => {
        const { server, postClaudeHook } = await createServer()
        try {
          await raiseChildPrompt(postClaudeHook)
          await postClaudeHook({ ...TURN, hook_event_name: 'Stop', ...liveWork })
          expect(server.getStatusSnapshot()[0]).toMatchObject({
            state: 'working',
            mainAgent: { state: 'done' }
          })
        } finally {
          server.stop()
        }
      }
    )

    it('keeps a child permission through a manual compact while other child work runs', async () => {
      const { server, postClaudeHook } = await createServer()
      try {
        await raiseChildPrompt(postClaudeHook)
        await postClaudeHook({ ...TURN, hook_event_name: 'SubagentStart', agent_id: 'aother' })
        await postClaudeHook({ ...TURN, hook_event_name: 'Stop' })
        await postClaudeHook({ ...TURN, hook_event_name: 'PostCompact', trigger: 'manual' })
        await postClaudeHook({
          ...TURN,
          hook_event_name: 'PreToolUse',
          agent_id: 'aother',
          tool_name: 'Read',
          tool_input: { file_path: 'notes.md' },
          tool_use_id: 'toolu-other'
        })
        expect(server.getStatusSnapshot()[0]).toMatchObject({ state: 'waiting', toolName: 'Bash' })

        await postClaudeHook({
          ...TURN,
          hook_event_name: 'PostToolUse',
          agent_id: CHILD_ID,
          tool_name: 'Bash',
          tool_input: { command: 'false' }
        })
        expect(server.getStatusSnapshot()[0]).toMatchObject({ state: 'working' })
      } finally {
        server.stop()
      }
    })
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
