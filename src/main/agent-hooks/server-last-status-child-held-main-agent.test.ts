import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentHookServer, _internals } from './server'
import { buildBody, postHookEvent, PANE, RUNNING_SHELL } from './server.test-fixtures'

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

const CHILD_PERMISSION = {
  hook_event_name: 'PermissionRequest',
  agent_id: 'achild-a',
  tool_name: 'Bash',
  tool_input: { command: 'rm scratch' }
}

// A Claude row whose main agent settled while child agents still work (or wait on a prompt) is
// decided by the row's `mainAgent` fact: OSC cannot settle it, and restart restores the settled
// main agent so the children's own lifecycle hooks can.
describe('Claude rows held open by child agents', () => {
  let userDataPath: string

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-child-held-main-agent-'))
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
  })

  async function startServer(): Promise<AgentHookServer> {
    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    return server
  }

  async function restart(server: AgentHookServer): Promise<AgentHookServer> {
    await server.flushStatusPersist()
    await server.stop()
    return startServer()
  }

  async function post(server: AgentHookServer, payload: Record<string, unknown>): Promise<void> {
    await postHookEvent(server, buildBody(payload))
  }

  async function settleMainAgentBeside(server: AgentHookServer, childIds: string[]): Promise<void> {
    await post(server, { hook_event_name: 'UserPromptSubmit', prompt: 'delegate' })
    for (const id of childIds) {
      await post(server, { hook_event_name: 'SubagentStart', agent_id: id })
    }
    await post(server, { hook_event_name: 'Stop' })
  }

  function osc(server: AgentHookServer, state: 'working' | 'done'): void {
    server.ingestTerminalStatus({
      paneKey: PANE,
      connectionId: null,
      payload: { state, prompt: '', agentType: 'claude' }
    })
  }

  function row(server: AgentHookServer) {
    return server.getStatusSnapshot()[0]
  }

  it('keeps a child permission prompt visible when OSC reports done', async () => {
    const server = await startServer()
    try {
      await settleMainAgentBeside(server, ['achild-a'])
      await post(server, CHILD_PERMISSION)
      osc(server, 'done')

      expect(row(server)).toMatchObject({
        state: 'waiting',
        toolName: 'Bash',
        mainAgent: { state: 'done' }
      })
    } finally {
      await server.stop()
    }
  })

  it('keeps a child-held working row when OSC reports done', async () => {
    const server = await startServer()
    try {
      await settleMainAgentBeside(server, ['achild-a'])
      osc(server, 'done')

      expect(row(server)).toMatchObject({
        state: 'working',
        mainAgent: { state: 'done' },
        subagents: [expect.objectContaining({ id: 'achild-a', state: 'working' })]
      })
    } finally {
      await server.stop()
    }
  })

  it('settles a restored child permission wait once the child is approved and stops', async () => {
    let server = await startServer()
    await settleMainAgentBeside(server, ['achild-a'])
    await post(server, CHILD_PERMISSION)
    server = await restart(server)
    try {
      await post(server, {
        hook_event_name: 'PreToolUse',
        agent_id: 'achild-a',
        tool_name: 'Bash',
        tool_input: { command: 'rm scratch' },
        tool_use_id: 'toolu-approved'
      })
      expect(row(server)?.state).toBe('working')
      await post(server, { hook_event_name: 'SubagentStop', agent_id: 'achild-a' })

      expect(row(server)).toMatchObject({ state: 'done', mainAgent: { state: 'done' } })
      expect(row(server)?.restoredUnconfirmed).toBeUndefined()
    } finally {
      await server.stop()
    }
  })

  it('settles a restored drained row after a later child starts and stops', async () => {
    let server = await startServer()
    await settleMainAgentBeside(server, ['achild-a'])
    await post(server, { hook_event_name: 'SubagentStop', agent_id: 'achild-a' })
    server = await restart(server)
    try {
      await post(server, { hook_event_name: 'SubagentStart', agent_id: 'achild-b' })
      expect(row(server)?.state).toBe('working')
      await post(server, { hook_event_name: 'SubagentStop', agent_id: 'achild-b' })

      expect(row(server)).toMatchObject({ state: 'done', mainAgent: { state: 'done' } })
    } finally {
      await server.stop()
    }
  })

  it('settles a restored plain done row after a later child starts and stops', async () => {
    let server = await startServer()
    await settleMainAgentBeside(server, [])
    server = await restart(server)
    try {
      await post(server, { hook_event_name: 'SubagentStart', agent_id: 'achild-b' })
      expect(row(server)?.state).toBe('working')
      await post(server, { hook_event_name: 'SubagentStop', agent_id: 'achild-b' })

      expect(row(server)).toMatchObject({ state: 'done', mainAgent: { state: 'done' } })
    } finally {
      await server.stop()
    }
  })

  it('pushes the held child permission row when the main agent behind it changes', async () => {
    const server = await startServer()
    try {
      await settleMainAgentBeside(server, ['achild-a'])
      await post(server, CHILD_PERMISSION)
      const pushed: { state: string; mainAgent?: { state: string } }[] = []
      server.subscribeEnrichedStatus((enriched) => pushed.push(enriched.payload))
      await post(server, { hook_event_name: 'PreToolUse', tool_name: 'Read' })
      expect(pushed).toEqual([
        expect.objectContaining({
          state: 'waiting',
          mainAgent: expect.objectContaining({ state: 'working' })
        })
      ])
      // The main agent keeps working: nothing it publishes changed, so nothing is pushed.
      await post(server, { hook_event_name: 'PreToolUse', tool_name: 'Grep' })
      expect(pushed).toHaveLength(1)
    } finally {
      await server.stop()
    }
  })

  it('does not settle a restored row whose main agent resumed behind a child permission', async () => {
    let server = await startServer()
    await settleMainAgentBeside(server, ['achild-a', 'achild-b'])
    await post(server, CHILD_PERMISSION)
    await post(server, { hook_event_name: 'PreToolUse', tool_name: 'Read' })
    expect(row(server)).toMatchObject({
      state: 'waiting',
      toolName: 'Bash',
      mainAgent: { state: 'working' }
    })
    server = await restart(server)
    try {
      await post(server, { hook_event_name: 'SubagentStop', agent_id: 'achild-a' })
      await post(server, { hook_event_name: 'SubagentStop', agent_id: 'achild-b' })

      expect(row(server)).toMatchObject({ state: 'working', restoredUnconfirmed: true })
    } finally {
      await server.stop()
    }
  })

  it('does not settle a restored row a running shell held beside its child', async () => {
    let server = await startServer()
    await post(server, { hook_event_name: 'UserPromptSubmit', prompt: 'delegate' })
    await post(server, { hook_event_name: 'SubagentStart', agent_id: 'achild-a' })
    await post(server, {
      hook_event_name: 'Stop',
      background_tasks: [{ id: 'achild-a', type: 'subagent', status: 'running' }, RUNNING_SHELL]
    })
    server = await restart(server)
    try {
      await post(server, { hook_event_name: 'SubagentStop', agent_id: 'achild-a' })

      expect(row(server)).toMatchObject({ state: 'working', restoredUnconfirmed: true })
    } finally {
      await server.stop()
    }
  })

  it('does not settle a restored row whose main agent left a shell running behind a child permission', async () => {
    let server = await startServer()
    await post(server, { hook_event_name: 'UserPromptSubmit', prompt: 'delegate' })
    await post(server, { hook_event_name: 'SubagentStart', agent_id: 'achild-a' })
    await post(server, CHILD_PERMISSION)
    await post(server, {
      hook_event_name: 'Stop',
      background_tasks: [{ id: 'achild-a', type: 'subagent', status: 'running' }, RUNNING_SHELL]
    })
    expect(row(server)).toMatchObject({ state: 'waiting', mainAgent: { state: 'done' } })
    server = await restart(server)
    try {
      await post(server, {
        hook_event_name: 'PreToolUse',
        agent_id: 'achild-a',
        tool_name: 'Bash',
        tool_input: { command: 'rm scratch' },
        tool_use_id: 'toolu-approved'
      })
      await post(server, { hook_event_name: 'SubagentStop', agent_id: 'achild-a' })

      expect(row(server)?.state).toBe('working')
    } finally {
      await server.stop()
    }
  })

  it('keeps a row open for the shell a main agent left behind a child permission', async () => {
    const server = await startServer()
    try {
      await post(server, { hook_event_name: 'UserPromptSubmit', prompt: 'delegate' })
      await post(server, { hook_event_name: 'SubagentStart', agent_id: 'achild-a' })
      await post(server, CHILD_PERMISSION)
      await post(server, {
        hook_event_name: 'Stop',
        background_tasks: [{ id: 'achild-a', type: 'subagent', status: 'running' }, RUNNING_SHELL]
      })
      await post(server, {
        hook_event_name: 'PreToolUse',
        agent_id: 'achild-a',
        tool_name: 'Bash',
        tool_input: { command: 'rm scratch' },
        tool_use_id: 'toolu-approved'
      })
      await post(server, { hook_event_name: 'SubagentStop', agent_id: 'achild-a' })

      expect(row(server)?.state).toBe('working')
    } finally {
      await server.stop()
    }
  })

  it('settles a restored row after an inferred child answer when no shell ran', async () => {
    let server = await startServer()
    await settleMainAgentBeside(server, ['achild-a'])
    await post(server, {
      hook_event_name: 'PreToolUse',
      agent_id: 'achild-a',
      tool_name: 'AskUserQuestion',
      tool_use_id: 'toolu-question'
    })
    const waiting = row(server)
    expect(
      server.inferQuestionAnswered({
        paneKey: PANE,
        baselineUpdatedAt: waiting?.receivedAt ?? 0,
        baselineStateStartedAt: waiting?.stateStartedAt ?? 0,
        baselinePrompt: waiting?.prompt ?? '',
        baselineAgentType: 'claude'
      })
    ).toBe(true)
    server = await restart(server)
    try {
      await post(server, { hook_event_name: 'SubagentStop', agent_id: 'achild-a' })

      expect(row(server)).toMatchObject({ state: 'done', mainAgent: { state: 'done' } })
    } finally {
      await server.stop()
    }
  })

  // The shell fact rides beside `mainAgent`; a row rewritten without it would read as shell-free.
  async function expectShellHeldRowStaysOpenAfterRestart(
    server: AgentHookServer,
    childEvents: Record<string, unknown>[]
  ): Promise<void> {
    const restarted = await restart(server)
    try {
      for (const event of childEvents) {
        await post(restarted, event)
      }

      expect(row(restarted)?.state).toBe('working')
    } finally {
      restarted.stop()
    }
  }

  it('keeps the shell fact when OSC repaints a shell-held row', async () => {
    const server = await startServer()
    await post(server, { hook_event_name: 'UserPromptSubmit', prompt: 'build in background' })
    await post(server, { hook_event_name: 'Stop', background_tasks: [RUNNING_SHELL] })
    server.ingestTerminalStatus({
      paneKey: PANE,
      connectionId: null,
      payload: { state: 'working', prompt: 'title text', agentType: 'claude' }
    })
    expect(row(server)).toMatchObject({ state: 'working', prompt: 'title text' })

    await expectShellHeldRowStaysOpenAfterRestart(server, [
      { hook_event_name: 'SubagentStart', agent_id: 'achild-b' },
      { hook_event_name: 'SubagentStop', agent_id: 'achild-b' }
    ])
  })

  it('keeps the shell fact when an answered child question is inferred', async () => {
    const server = await startServer()
    await post(server, { hook_event_name: 'UserPromptSubmit', prompt: 'delegate' })
    await post(server, { hook_event_name: 'SubagentStart', agent_id: 'achild-a' })
    await post(server, {
      hook_event_name: 'Stop',
      background_tasks: [{ id: 'achild-a', type: 'subagent', status: 'running' }, RUNNING_SHELL]
    })
    await post(server, {
      hook_event_name: 'PreToolUse',
      agent_id: 'achild-a',
      tool_name: 'AskUserQuestion',
      tool_use_id: 'toolu-question'
    })
    const waiting = row(server)
    expect(waiting).toMatchObject({ state: 'waiting', toolName: 'AskUserQuestion' })
    expect(
      server.inferQuestionAnswered({
        paneKey: PANE,
        baselineUpdatedAt: waiting?.receivedAt ?? 0,
        baselineStateStartedAt: waiting?.stateStartedAt ?? 0,
        baselinePrompt: waiting?.prompt ?? '',
        baselineAgentType: 'claude'
      })
    ).toBe(true)
    expect(row(server)).toMatchObject({ state: 'working', mainAgent: { state: 'done' } })

    await expectShellHeldRowStaysOpenAfterRestart(server, [
      { hook_event_name: 'SubagentStop', agent_id: 'achild-a' }
    ])
  })
})
