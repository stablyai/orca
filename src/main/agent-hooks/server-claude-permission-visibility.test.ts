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
  trackMock.mockReset()
  getCohortAtEmitMock.mockReset()
  getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('AgentHookServer listener replay', () => {
  it('keeps Claude permission visible when another subagent reports tool activity', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const env = server.buildPtyEnv()
      const postClaudeHook = async (payload: Record<string, unknown>): Promise<Response> =>
        fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/claude`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
          },
          body: JSON.stringify(buildBody(payload))
        })

      await expect(
        postClaudeHook({
          hook_event_name: 'PermissionRequest',
          tool_name: 'Bash',
          tool_input: { command: 'rm -rf /tmp/orca-subagent-repro' }
        })
      ).resolves.toMatchObject({ status: 204 })
      await expect(
        postClaudeHook({
          hook_event_name: 'PreToolUse',
          tool_name: 'Read',
          tool_input: { file_path: '/tmp/other-subagent.txt' }
        })
      ).resolves.toMatchObject({ status: 204 })

      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({
          paneKey: PANE,
          state: 'waiting',
          agentType: 'claude',
          toolName: 'Bash',
          toolInput: 'rm -rf /tmp/orca-subagent-repro'
        })
      ])
    } finally {
      server.stop()
    }
  })

  it('keeps Claude permission visible when matching tool activity has no execution id', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const env = server.buildPtyEnv()
      const postClaudeHook = async (payload: Record<string, unknown>): Promise<Response> =>
        fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/claude`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
          },
          body: JSON.stringify(buildBody(payload))
        })

      await postClaudeHook({
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf /tmp/orca-subagent-repro' }
      })
      await postClaudeHook({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf /tmp/orca-subagent-repro' }
      })

      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({
          paneKey: PANE,
          state: 'waiting',
          agentType: 'claude',
          toolName: 'Bash',
          toolInput: 'rm -rf /tmp/orca-subagent-repro'
        })
      ])
    } finally {
      server.stop()
    }
  })

  it('keeps Claude permission visible when approved tool execution has no identity', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const env = server.buildPtyEnv()
      const postClaudeHook = async (payload: Record<string, unknown>): Promise<Response> =>
        fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/claude`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
          },
          body: JSON.stringify(buildBody(payload))
        })

      await postClaudeHook({
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf /tmp/orca-subagent-repro' }
      })
      await postClaudeHook({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf /tmp/orca-subagent-repro' },
        tool_use_id: 'toolu-approved-1'
      })

      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({
          paneKey: PANE,
          state: 'waiting',
          agentType: 'claude',
          toolName: 'Bash',
          toolInput: 'rm -rf /tmp/orca-subagent-repro'
        })
      ])
    } finally {
      server.stop()
    }
  })

  it('lets Claude permission clear when approved PostToolUse matches the preceding tool use id', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const env = server.buildPtyEnv()
      const postClaudeHook = async (payload: Record<string, unknown>): Promise<Response> =>
        fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/claude`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
          },
          body: JSON.stringify(buildBody(payload))
        })

      await postClaudeHook({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf /tmp/orca-2824-permission-target' },
        tool_use_id: 'toolu-approved-by-claude'
      })
      await postClaudeHook({
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf /tmp/orca-2824-permission-target' }
      })
      await postClaudeHook({
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf /tmp/orca-2824-permission-target' },
        tool_use_id: 'toolu-approved-by-claude'
      })

      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({
          paneKey: PANE,
          state: 'working',
          agentType: 'claude',
          toolName: 'Bash',
          toolInput: 'rm -rf /tmp/orca-2824-permission-target'
        })
      ])
    } finally {
      server.stop()
    }
  })

  it('lets Claude permission clear by tool use id when tool input is not previewable', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const env = server.buildPtyEnv()
      const postClaudeHook = async (payload: Record<string, unknown>): Promise<Response> =>
        fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/claude`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
          },
          body: JSON.stringify(buildBody(payload))
        })

      await postClaudeHook({
        hook_event_name: 'PreToolUse',
        tool_name: 'BespokeTool',
        tool_input: { opaque: 'request-a' },
        tool_use_id: 'toolu-approved-opaque'
      })
      await postClaudeHook({
        hook_event_name: 'PermissionRequest',
        tool_name: 'BespokeTool',
        tool_input: { opaque: 'request-a' }
      })
      await postClaudeHook({
        hook_event_name: 'PostToolUse',
        tool_name: 'BespokeTool',
        tool_input: { opaque: 'request-a' },
        tool_use_id: 'toolu-approved-opaque'
      })

      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({
          paneKey: PANE,
          state: 'working',
          agentType: 'claude',
          toolName: 'BespokeTool'
        })
      ])
    } finally {
      server.stop()
    }
  })

  it('keeps Claude permission visible for unpreviewable tool input with another tool use id', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const env = server.buildPtyEnv()
      const postClaudeHook = async (payload: Record<string, unknown>): Promise<Response> =>
        fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/claude`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
          },
          body: JSON.stringify(buildBody(payload))
        })

      await postClaudeHook({
        hook_event_name: 'PreToolUse',
        tool_name: 'BespokeTool',
        tool_input: { opaque: 'request-a' },
        tool_use_id: 'toolu-permission-owner-opaque'
      })
      await postClaudeHook({
        hook_event_name: 'PermissionRequest',
        tool_name: 'BespokeTool',
        tool_input: { opaque: 'request-a' }
      })
      await postClaudeHook({
        hook_event_name: 'PostToolUse',
        tool_name: 'BespokeTool',
        tool_input: { opaque: 'request-b' },
        tool_use_id: 'toolu-other-opaque'
      })

      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({
          paneKey: PANE,
          state: 'waiting',
          agentType: 'claude',
          toolName: 'BespokeTool'
        })
      ])
    } finally {
      server.stop()
    }
  })

  it('keeps Claude permission visible when another tool use completes after permission', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const env = server.buildPtyEnv()
      const postClaudeHook = async (payload: Record<string, unknown>): Promise<Response> =>
        fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/claude`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
          },
          body: JSON.stringify(buildBody(payload))
        })

      await postClaudeHook({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'pnpm test' },
        tool_use_id: 'toolu-permission-owner'
      })
      await postClaudeHook({
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'pnpm test' }
      })
      await postClaudeHook({
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'pnpm test' },
        tool_use_id: 'toolu-other-subagent'
      })

      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({
          paneKey: PANE,
          state: 'waiting',
          agentType: 'claude',
          toolName: 'Bash',
          toolInput: 'pnpm test'
        })
      ])
    } finally {
      server.stop()
    }
  })

  it('keeps Claude permission visible when an explicit agent type reports another tool use id', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const env = server.buildPtyEnv()
      const postClaudeHook = async (payload: Record<string, unknown>): Promise<Response> =>
        fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/claude`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
          },
          body: JSON.stringify(buildBody(payload))
        })

      await postClaudeHook({
        hook_event_name: 'PreToolUse',
        agent_type: 'main',
        tool_name: 'Bash',
        tool_input: { command: 'pnpm test' },
        tool_use_id: 'toolu-permission-owner-type'
      })
      await postClaudeHook({
        hook_event_name: 'PermissionRequest',
        agent_type: 'main',
        tool_name: 'Bash',
        tool_input: { command: 'pnpm test' }
      })
      await postClaudeHook({
        hook_event_name: 'PostToolUse',
        agent_type: 'main',
        tool_name: 'Bash',
        tool_input: { command: 'pnpm test' },
        tool_use_id: 'toolu-other-type'
      })

      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({
          paneKey: PANE,
          state: 'waiting',
          agentType: 'claude',
          toolName: 'Bash',
          toolInput: 'pnpm test'
        })
      ])
    } finally {
      server.stop()
    }
  })

  it('lets Claude permission clear when same explicit agent type starts the approved tool', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const env = server.buildPtyEnv()
      const postClaudeHook = async (payload: Record<string, unknown>): Promise<Response> =>
        fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/claude`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
          },
          body: JSON.stringify(buildBody(payload))
        })

      await postClaudeHook({
        hook_event_name: 'PermissionRequest',
        agent_type: 'main',
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf /tmp/orca-subagent-repro' }
      })
      await postClaudeHook({
        hook_event_name: 'PreToolUse',
        agent_type: 'main',
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf /tmp/orca-subagent-repro' },
        tool_use_id: 'toolu-approved-1'
      })

      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({
          paneKey: PANE,
          state: 'working',
          agentType: 'claude',
          toolName: 'Bash',
          toolInput: 'rm -rf /tmp/orca-subagent-repro'
        })
      ])
    } finally {
      server.stop()
    }
  })

  it('lets Claude subagent permission clear when the same agent starts the approved tool', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const env = server.buildPtyEnv()
      const postClaudeHook = async (payload: Record<string, unknown>): Promise<Response> =>
        fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/claude`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
          },
          body: JSON.stringify(buildBody(payload))
        })

      await postClaudeHook({
        hook_event_name: 'PermissionRequest',
        agent_id: 'agent-subagent-a',
        agent_type: 'Review',
        tool_name: 'Bash',
        tool_input: { command: 'pnpm test' }
      })
      await postClaudeHook({
        hook_event_name: 'PreToolUse',
        agent_id: 'agent-subagent-a',
        agent_type: 'Review',
        tool_name: 'Bash',
        tool_input: { command: 'pnpm test' },
        tool_use_id: 'toolu-approved-subagent'
      })

      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({
          paneKey: PANE,
          state: 'working',
          agentType: 'claude',
          toolName: 'Bash',
          toolInput: 'pnpm test'
        })
      ])
    } finally {
      server.stop()
    }
  })

  it('lets same Claude subagent clear an unknown approved tool without an input preview', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const env = server.buildPtyEnv()
      const postClaudeHook = async (payload: Record<string, unknown>): Promise<Response> =>
        fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/claude`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
          },
          body: JSON.stringify(buildBody(payload))
        })

      await postClaudeHook({
        hook_event_name: 'PermissionRequest',
        agent_id: 'agent-custom-tool',
        agent_type: 'Review',
        tool_name: 'BespokeTool',
        tool_input: { request_id: 'pending-1' }
      })
      await postClaudeHook({
        hook_event_name: 'PreToolUse',
        agent_id: 'agent-custom-tool',
        agent_type: 'Review',
        tool_name: 'BespokeTool',
        tool_input: { request_id: 'pending-1' },
        tool_use_id: 'toolu-custom-approved'
      })

      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({
          paneKey: PANE,
          state: 'working',
          agentType: 'claude',
          toolName: 'BespokeTool',
          toolInput: undefined
        })
      ])
    } finally {
      server.stop()
    }
  })

  it('keeps Claude permission visible when another same-type subagent reports the same tool execution', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const env = server.buildPtyEnv()
      const postClaudeHook = async (payload: Record<string, unknown>): Promise<Response> =>
        fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/claude`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
          },
          body: JSON.stringify(buildBody(payload))
        })

      await postClaudeHook({
        hook_event_name: 'PermissionRequest',
        agent_id: 'agent-subagent-a',
        agent_type: 'Review',
        tool_name: 'Bash',
        tool_input: { command: 'pnpm test' }
      })
      await postClaudeHook({
        hook_event_name: 'PreToolUse',
        agent_id: 'agent-subagent-b',
        agent_type: 'Review',
        tool_name: 'Bash',
        tool_input: { command: 'pnpm test' },
        tool_use_id: 'toolu-other-subagent'
      })

      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({
          paneKey: PANE,
          state: 'waiting',
          agentType: 'claude',
          toolName: 'Bash',
          toolInput: 'pnpm test'
        })
      ])
    } finally {
      server.stop()
    }
  })

  it('keeps Claude permission visible when unknown tool previews collide', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const env = server.buildPtyEnv()
      const postClaudeHook = async (payload: Record<string, unknown>): Promise<Response> =>
        fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/claude`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
          },
          body: JSON.stringify(buildBody(payload))
        })

      await postClaudeHook({
        hook_event_name: 'PermissionRequest',
        tool_name: 'BespokeTool',
        tool_input: { request_id: 'pending-1' }
      })
      await postClaudeHook({
        hook_event_name: 'PreToolUse',
        tool_name: 'BespokeTool',
        tool_input: { request_id: 'other-subagent' }
      })

      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({
          paneKey: PANE,
          state: 'waiting',
          agentType: 'claude',
          toolName: 'BespokeTool',
          toolInput: undefined
        })
      ])
    } finally {
      server.stop()
    }
  })

  it('lets Claude permission clear when a new explicit prompt starts', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const env = server.buildPtyEnv()
      const postClaudeHook = async (payload: Record<string, unknown>): Promise<Response> =>
        fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/claude`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
          },
          body: JSON.stringify(buildBody(payload))
        })

      await postClaudeHook({
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf /tmp/orca-subagent-repro' }
      })
      await postClaudeHook({
        hook_event_name: 'UserPromptSubmit',
        prompt: 'start a new task'
      })

      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({
          paneKey: PANE,
          state: 'working',
          agentType: 'claude',
          prompt: 'start a new task',
          toolName: undefined,
          toolInput: undefined
        })
      ])
    } finally {
      server.stop()
    }
  })

  it('does not replay cleared pane state to a newly attached listener', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const env = server.buildPtyEnv()
      await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/codex`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
        },
        body: JSON.stringify(
          buildBody({
            hook_event_name: 'UserPromptSubmit',
            prompt: 'clear me'
          })
        )
      })

      server.clearPaneState(PANE)
      const listener = vi.fn()
      server.setListener(listener)

      expect(listener).not.toHaveBeenCalled()
    } finally {
      server.stop()
    }
  })
})
