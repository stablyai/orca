import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from './server'
import captures from '../../shared/agent-hook-listener/__fixtures__/declined-permission-hooks.json'
import { buildBody, postHookEvent, PANE } from './server.test-fixtures'

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
  it('keeps Claude permission visible across unattributed activity from another tool', async () => {
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

async function withClaudePane(
  run: (
    post: (raw: Record<string, unknown>) => Promise<string>,
    server: AgentHookServer
  ) => Promise<void>
): Promise<void> {
  const server = new AgentHookServer()
  await server.start({ env: 'production' })
  try {
    await run(async (raw) => {
      await postHookEvent(server, buildBody(raw))
      return server.getStatusSnapshot()[0].state
    }, server)
  } finally {
    server.stop()
  }
}

const [start, submit] = captures.claudeDecline
const root = { session_id: start.session_id, prompt_id: submit.prompt_id }
const child = { agent_id: 'child-a', agent_type: 'general-purpose' }
const readAt = (offset: number) => ({ tool_name: 'Read', tool_input: { file_path: '/x', offset } })
const hook = (hook_event_name: string, fields: Record<string, unknown> = {}) => ({
  ...root,
  hook_event_name,
  ...fields
})
const pre = (id: string, tool: Record<string, unknown>, owner = {}) =>
  hook('PreToolUse', { ...tool, tool_use_id: id, ...owner })
const ask = (tool: Record<string, unknown>, owner = {}) =>
  hook('PermissionRequest', { ...tool, ...owner })
const done = (id: string, tool: Record<string, unknown>, owner = {}) =>
  hook('PostToolUse', { ...tool, tool_use_id: id, tool_response: 'ok', ...owner })
const batch = (calls: [string, Record<string, unknown>][], owner = {}) =>
  hook('PostToolBatch', {
    tool_calls: calls.map(([tool_use_id, tool]) => ({ ...tool, tool_use_id, tool_response: 'r' })),
    ...owner
  })

describe('the represented Claude request on its execution host', () => {
  it.each([
    ['claudeDecline', 5],
    ['claudeParallel', 10],
    ['claudeChild', 20]
  ] as const)(
    'keeps recorded %s waiting through siblings and child work, and clears at its own completed batch',
    async (capture, settledAt) => {
      await withClaudePane(async (post, server) => {
        const raws = captures[capture]
        const asked = raws.findIndex((raw) => raw.hook_event_name === 'PermissionRequest')
        for (const [index, raw] of raws.entries()) {
          if (raw.hook_event_name === 'Stop') {
            break
          }
          const state = await post(raw)
          if (index >= asked && index < settledAt) {
            expect({ index, row: server.getStatusSnapshot()[0] }).toMatchObject({
              index,
              row: { state: 'waiting', toolName: 'Read' }
            })
          } else if (index >= settledAt) {
            expect({ index, state }).toEqual({ index, state: 'working' })
          }
        }
      })
    }
  )

  it('restores the lead a child request displaced when the child’s own batch completes it', async () => {
    await withClaudePane(async (post, server) => {
      const tool = readAt(0)
      await post(start)
      await post(submit)
      await post(hook('SubagentStart', child))
      await post(pre('C', tool, child))
      expect(await post(ask(tool, child))).toBe('waiting')
      expect(await post(batch([['C', tool]], child))).toBe('working')
      expect(server.getStatusSnapshot()[0].mainAgent?.state).toBe('working')
    })
  })

  it('keeps a sole prompt waiting while its allowed identical sibling finishes, until the batch', async () => {
    await withClaudePane(async (post) => {
      const tool = readAt(0)
      await post(start)
      await post(submit)
      // T's Pre comes last, so the request follows it; U's identical input must not end T's prompt.
      await post(pre('U', tool))
      await post(pre('T', tool))
      expect(await post(ask(tool))).toBe('waiting')
      expect(await post(done('U', tool))).toBe('waiting')
      expect(
        await post(
          batch([
            ['T', tool],
            ['U', tool]
          ])
        )
      ).toBe('working')
    })
  })

  it('accepted (Brennan 2026-11-03): NC2 after an earlier batch release, an equal-preview sibling can clear a still-open prompt', async () => {
    await withClaudePane(async (post) => {
      const other = { tool_name: 'Read', tool_input: { file_path: '/a' } }
      await post(start)
      await post(submit)
      await post(pre('A', other))
      await post(ask(other))
      expect(await post(batch([['A', other]]))).toBe('working')
      await post(pre('T', readAt(0)))
      await post(pre('U', readAt(100)))
      expect(await post(ask(readAt(0)))).toBe('waiting')
      // Main keeps T here (A stays held there, so T inherits nothing); the legacy preview inheritance now
      // reads U as T's predecessor and its completion clears T while T is still open.
      expect(await post(done('U', readAt(100)))).toBe('working')
    })
  })

  it('accepted (Brennan 2026-11-03): NC1 a late older batch with the same input clears a newer sole prompt', async () => {
    await withClaudePane(async (post) => {
      const tool = readAt(0)
      await post(start)
      await post(submit)
      await post(pre('T', tool))
      expect(await post(ask(tool))).toBe('waiting')
      // W's batch, same owner and input, delivered after T's request: main ignores it; the input match does not.
      expect(await post(batch([['W', tool]]))).toBe('working')
    })
  })

  it('accepted (Brennan 2026-11-03): NC4 a helper’s request whose own end is lost outlives the parent’s finish', async () => {
    await withClaudePane(async (post) => {
      const helper = { agent_id: 'hook-agent-1' }
      await post(start)
      await post(submit)
      await post(pre('H', readAt(0), helper))
      expect(await post(ask(readAt(0), helper))).toBe('waiting')
      // Main can show Done here; the request stays until the helper's own end or a real replacement.
      expect(await post(hook('Stop'))).toBe('waiting')
      expect(await post(hook('UserPromptSubmit', { prompt: 'Next' }))).toBe('working')
    })
  })

  it('keeps the request through a lifecycle refresh of the waiting lead, so its batch still clears it', async () => {
    await withClaudePane(async (post, server) => {
      const tool = { tool_name: 'Read', tool_input: { file_path: '/a' } }
      await post(start)
      await post(hook('UserPromptSubmit', { prompt: 'Read /a' }))
      await post(pre('A', tool))
      expect(await post(ask(tool))).toBe('waiting')
      expect(
        await post(hook('SubagentStart', { agent_id: 'child-c', agent_type: 'general-purpose' }))
      ).toBe('waiting')
      expect(await post(batch([['A', tool]]))).toBe('working')

      // A child's own request survives another child's start the same way, and its batch restores the lead.
      await post(hook('SubagentStart', child))
      await post(pre('C', readAt(0), child))
      expect(await post(ask(readAt(0), child))).toBe('waiting')
      await post(hook('SubagentStart', { agent_id: 'child-d', agent_type: 'general-purpose' }))
      expect(await post(batch([['C', readAt(0)]], child))).toBe('working')
      expect(server.getStatusSnapshot()[0].mainAgent?.state).toBe('working')

      // A real newer dialog still replaces the request: its batch then leaves the question alone.
      const question = {
        tool_name: 'AskUserQuestion',
        tool_input: { questions: [{ question: 'Which?' }] }
      }
      await post(pre('B', tool))
      await post(ask(tool))
      await post(pre('Q', question))
      expect(await post(ask(question))).toBe('waiting')
      await post(batch([['B', tool]]))
      expect(server.getStatusSnapshot()[0]).toMatchObject({
        state: 'waiting',
        toolName: 'AskUserQuestion'
      })
    })
  })

  it('ends even a helper’s request when a new conversation starts, while compact and a parent Stop do not', async () => {
    await withClaudePane(async (post) => {
      const helper = { agent_id: 'hook-agent-1' }
      await post(start)
      await post(submit)
      await post(pre('H', readAt(0), helper))
      expect(await post(ask(readAt(0), helper))).toBe('waiting')
      expect(await post(hook('PostCompact', { trigger: 'auto' }))).toBe('waiting')
      expect(await post(hook('Stop'))).toBe('waiting')
      // /clear: a genuinely new session, idle until its own first prompt.
      const s2 = '22222222-2222-4222-8222-222222222222'
      expect(await post({ ...start, session_id: s2, source: 'clear' })).toBe('done')
      // The new conversation's own request still settles at its batch.
      const next = { session_id: s2 }
      await post({ ...submit, ...next })
      await post({ ...pre('N', readAt(5)), ...next })
      expect(await post({ ...ask(readAt(5)), ...next })).toBe('waiting')
      expect(await post({ ...batch([['N', readAt(5)]]), ...next })).toBe('working')
    })
  })

  it('ends a child’s request at a complete inventory that ends that child, but not while it still runs', async () => {
    await withClaudePane(async (post) => {
      await post(start)
      await post(submit)
      await post(hook('SubagentStart', child))
      await post(pre('C', readAt(0), child))
      expect(await post(ask(readAt(0), child))).toBe('waiting')
      expect(
        await post(
          hook('Stop', {
            background_tasks: [{ id: child.agent_id, type: 'subagent', status: 'running' }]
          })
        )
      ).toBe('waiting')
      expect(await post(hook('Stop', { background_tasks: [] }))).not.toBe('waiting')
    })
  })
})
