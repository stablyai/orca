import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from './server'
import { HOOK_SILENCE_BEFORE_PROGRAM_STATUS_FALLBACK_MS } from './server/program-status/hook-precedence'
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
    vi.useRealTimers()
    server.stop()
  }
}

const [start, submit] = captures.claudeDecline
const root = { session_id: start.session_id, prompt_id: submit.prompt_id }
const typed = { agent_type: 'reviewer' }
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
const batch = (ids: string[], owner = {}) =>
  hook('PostToolBatch', { tool_calls: ids.map((tool_use_id) => ({ tool_use_id })), ...owner })

describe('Claude requests bound to their single in-flight call', () => {
  it.each([
    ['claudeDecline', 5],
    ['claudeParallel', 10],
    ['claudeChild', 20]
  ] as const)(
    'keeps recorded %s waiting through siblings and child work, and clears at its batch before the turn ends',
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

  it('keeps a child request through its own different-input sibling and clears on its own completion', async () => {
    await withClaudePane(async (post) => {
      await post(start)
      await post(submit)
      await post(pre('P', { tool_name: 'Agent', tool_input: { prompt: 'look' } }))
      await post(hook('SubagentStart', child))
      await post(pre('T', readAt(0), child))
      await post(pre('V', { tool_name: 'Bash', tool_input: { command: 'ls' } }, child))
      expect(await post(ask(readAt(0), child))).toBe('waiting')
      expect(
        await post(done('V', { tool_name: 'Bash', tool_input: { command: 'ls' } }, child))
      ).toBe('waiting')
      expect(await post(done('T', readAt(0), child))).toBe('working')
    })
  })

  it('ends only on its own settlement, and a batch that settles something else never becomes the row', async () => {
    await withClaudePane(async (post, server) => {
      await post(start)
      await post(submit)
      await post(pre('T', readAt(0), typed))
      await post(pre('U', readAt(100), typed))
      expect(await post(ask(readAt(0), typed))).toBe('waiting')
      // Same agent type and preview: main's guess would clear here.
      expect(await post(done('U', readAt(100), typed))).toBe('waiting')
      const held = server.getStatusSnapshot()[0]
      expect(await post(batch(['U'], typed))).toBe('waiting')
      // Another owner's batch naming the same id is not this request's settlement either.
      expect(await post(batch(['T'], child))).toBe('waiting')
      expect(server.getStatusSnapshot()[0]).toEqual(held)
      expect(await post(hook('PostToolUseFailure', { tool_use_id: 'T', ...typed }))).toBe('working')

      await post(pre('W', readAt(1)))
      expect(await post(ask(readAt(1)))).toBe('waiting')
      expect(await post(batch(['W']))).toBe('working')
    })
  })

  it('settles a held call listed after the 16th entry of a batch', async () => {
    await withClaudePane(async (post) => {
      await post(start)
      await post(submit)
      const ids = Array.from({ length: 20 }, (_, i) => `call-${i}`)
      for (const [i, id] of ids.entries()) {
        await post(pre(id, { tool_name: 'Read', tool_input: { file_path: `/f${i}` } }))
      }
      expect(await post(ask({ tool_name: 'Read', tool_input: { file_path: '/f18' } }))).toBe(
        'waiting'
      )
      expect(await post(batch(ids))).toBe('working')
    })
  })

  it('still ends at a new prompt, the owning child’s end and the turn’s end', async () => {
    await withClaudePane(async (post) => {
      await post(start)
      await post(submit)
      await post(pre('T', readAt(0)))
      expect(await post(ask(readAt(0)))).toBe('waiting')
      expect(await post(hook('UserPromptSubmit', { prompt: 'Do something else' }))).toBe('working')
      await post(hook('SubagentStart', child))
      await post(pre('C', readAt(1), child))
      expect(await post(ask(readAt(1), child))).toBe('waiting')
      expect(await post(hook('SubagentStop', child))).toBe('working')
      await post(pre('R', readAt(2)))
      expect(await post(ask(readAt(2)))).toBe('waiting')
      expect(await post(hook('Stop'))).toBe('done')
    })
  })

  it('holds terminal working behind a bound request and keeps the existing done fallback', async () => {
    await withClaudePane(async (post, server) => {
      for (const raw of captures.claudeParallel.slice(0, 5)) {
        await post(raw)
      }
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(Date.now() + HOOK_SILENCE_BEFORE_PROGRAM_STATUS_FALLBACK_MS + 1)
      const terminal = {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        connectionId: null,
        fromProgramStatus: true,
        renewsProgramStatusLease: true
      }
      server.ingestTerminalStatus({
        ...terminal,
        payload: { agentType: 'claude', state: 'working', prompt: '' }
      })
      expect(server.getStatusSnapshot()[0].state).toBe('waiting')
      server.ingestTerminalStatus({
        ...terminal,
        payload: { agentType: 'claude', state: 'done', prompt: '' }
      })
      expect(server.getStatusSnapshot()[0].state).toBe('done')
    })
  })

  it('accepted limitation (Brennan 2026-11-02): two open prompts for identical input can show working while the second is open', async () => {
    await withClaudePane(async (post) => {
      const X = { tool_name: 'Read', tool_input: { file_path: '/tmp/outside.txt' } }
      await post(start)
      await post(submit)
      await post(pre('A', X, typed))
      await post(ask(X, typed))
      expect(await post(batch(['A'], typed))).toBe('working')
      await post(pre('T', readAt(0), typed))
      expect(await post(ask(readAt(0), typed))).toBe('waiting')
      await post(pre('U', readAt(0), typed))
      // Both identical calls are in flight, so U's request cannot be named and takes main's path.
      expect(await post(ask(readAt(0), typed))).toBe('waiting')
      // U's prompt is still open here; main shows waiting. Accepted tradeoff, not a guarantee.
      expect(await post(done('T', readAt(0), typed))).toBe('working')
      expect(await post(hook('Stop', typed))).toBe('done')
    })
  })
})
