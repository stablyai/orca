import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from './server'
import { buildBody, LEAF_2, PANE, postHookEvent } from './server.test-fixtures'
import { makePaneKey } from '../../shared/stable-pane-id'
import { wslHookRelayConnectionId } from '../../shared/wsl-hook-relay-contract'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))
const probe = vi.hoisted(() =>
  vi.fn(async (): Promise<'live' | 'unverifiable' | 'exited'> => 'live')
)
vi.mock('../../shared/agent-process-presence-probe', () => ({ probeAgentProcessPresence: probe }))

const servers: AgentHookServer[] = []
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop()
  }
  probe.mockReset()
  probe.mockResolvedValue('live')
})

async function createServer(): Promise<AgentHookServer> {
  const server = new AgentHookServer()
  servers.push(server)
  await server.start({ env: 'production' })
  return server
}

const CLAUDE_PROCESS = JSON.stringify({
  pid: 4001,
  platform: process.platform,
  startTime: 'birth-4001'
})

async function claude(server: AgentHookServer, event: string, extra = {}): Promise<void> {
  const body = buildBody(
    { hook_event_name: event, session_id: 'claude-a', ...extra },
    { agentProcess: CLAUDE_PROCESS }
  )
  expect((await postHookEvent(server, body)).status).toBe(204)
}

async function codex(server: AgentHookServer, event: string, extra = {}): Promise<void> {
  const body = buildBody({ hook_event_name: event, session_id: 'codex-x', ...extra })
  expect((await postHookEvent(server, body, '/hook/codex')).status).toBe(204)
}

function row(server: AgentHookServer) {
  return server.getStatusSnapshot().find((entry) => entry.paneKey === PANE)
}

const toolUse = { tool_name: 'Bash', tool_input: { command: 'ls' } }

describe('ending a launched agent command', () => {
  it('hands the pane to the held guest when the command ends before any check', async () => {
    const server = await createServer()
    await claude(server, 'UserPromptSubmit', { prompt: 'claude task' })
    await codex(server, 'UserPromptSubmit', { prompt: 'codex task' })
    await vi.waitFor(() => expect(probe).toHaveBeenCalledOnce())
    expect(row(server)).toMatchObject({ agentType: 'claude' })
    server.endLaunchAuthority(PANE, 'claude')
    expect(row(server)).toMatchObject({ agentType: 'codex', prompt: 'codex task' })
    await codex(server, 'PreToolUse', toolUse)
    expect(row(server)).toMatchObject({ agentType: 'codex', toolName: 'Bash' })
  })

  it('keeps an owner the launch already handed the pane to, and admits its later events', async () => {
    const server = await createServer()
    await claude(server, 'UserPromptSubmit', { prompt: 'claude task' })
    probe.mockResolvedValue('exited')
    await codex(server, 'UserPromptSubmit', { prompt: 'codex task' })
    await vi.waitFor(() => expect(row(server)).toMatchObject({ agentType: 'codex' }))
    server.endLaunchAuthority(PANE, 'claude')
    await codex(server, 'PreToolUse', toolUse)
    expect(row(server)).toMatchObject({ agentType: 'codex', toolName: 'Bash' })
  })

  it("ends the launch's ownership into its resume remnant, and admits a new process", async () => {
    const server = await createServer()
    await claude(server, 'UserPromptSubmit', { prompt: 'claude task' })
    server.endLaunchAuthority(PANE, 'claude')
    const remnant = { providerSessionOnly: true, providerSession: { id: 'claude-a' } }
    expect(row(server)).toMatchObject(remnant)
    // Why: a late hook from the ended process never revives the pane.
    await claude(server, 'PreToolUse', toolUse)
    expect(row(server)).toMatchObject(remnant)
    const next = JSON.stringify({ pid: 4002, platform: process.platform, startTime: 'birth-4002' })
    const body = buildBody(
      { hook_event_name: 'PreToolUse', session_id: 'claude-b', ...toolUse },
      { agentProcess: next }
    )
    expect((await postHookEvent(server, body)).status).toBe(204)
    expect(row(server)).toMatchObject({ state: 'working', toolName: 'Bash' })
    expect(row(server)?.providerSessionOnly).toBeFalsy()
  })

  it.each([['claude-agent-teams'], ['openclaude']])(
    'ends a %s launch, whose hooks report claude',
    async (launchAgent) => {
      const server = await createServer()
      await claude(server, 'UserPromptSubmit', { prompt: 'claude task' })
      server.endLaunchAuthority(PANE, launchAgent)
      expect(row(server)).toMatchObject({ providerSessionOnly: true })
    }
  )

  it('resets the pane as before when a restart forgot the launch agent', async () => {
    const server = await createServer()
    await codex(server, 'UserPromptSubmit', { prompt: 'codex task' })
    server.endLaunchAuthority(PANE, null)
    expect(row(server)).toBeUndefined()
    await codex(server, 'PreToolUse', toolUse)
    expect(row(server)).toBeUndefined()
    await codex(server, 'UserPromptSubmit', { prompt: 'next task' })
    expect(row(server)).toMatchObject({ agentType: 'codex', prompt: 'next task' })
  })

  function relayed(server: AgentHookServer, connectionId: string): void {
    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        source: 'codex',
        hookEventName: 'UserPromptSubmit',
        providerSession: { key: 'session_id', id: 'codex-x' },
        agentPresence: { agent: 'codex' },
        payload: { state: 'working', prompt: 'task', agentType: 'codex' }
      },
      connectionId
    )
  }

  it.each([['codex'], [null]])(
    'leaves an SSH row to its relay (launch agent %s)',
    async (launchAgent) => {
      const server = await createServer()
      relayed(server, 'ssh-1')
      const before = row(server)
      server.endLaunchAuthority(PANE, launchAgent)
      expect(row(server)).toEqual(before)
    }
  )

  it('ends a WSL row, which this machine executes', async () => {
    const server = await createServer()
    relayed(server, wslHookRelayConnectionId('Ubuntu'))
    expect(row(server)).toMatchObject({ state: 'working' })
    server.endLaunchAuthority(PANE, 'codex')
    expect(row(server)).toMatchObject({ providerSessionOnly: true })
  })

  it('fences a session-less launch, then admits its new run once its process shows', async () => {
    const server = await createServer()
    const commandCode = (event: string) =>
      postHookEvent(server, buildBody({ hook_event_name: event, ...toolUse }), '/hook/command-code')
    await commandCode('PreToolUse')
    expect(row(server)).toMatchObject({ agentType: 'command-code' })
    server.endLaunchAuthority(PANE, 'command-code')
    expect(row(server)).toBeUndefined()
    await commandCode('PostToolUse')
    expect(row(server)).toBeUndefined()
    server.ingestTerminalStatus({
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      origin: 'process',
      payload: { state: 'working', prompt: '', agentType: 'command-code' }
    })
    await commandCode('PreToolUse')
    expect(row(server)).toMatchObject({
      state: 'working',
      agentType: 'command-code',
      toolName: 'Bash'
    })
  })

  it.each([['Stop'], ['PostToolUse']])(
    'drops a late %s from a launch with no process, and revives on a new prompt',
    async (late) => {
      const server = await createServer()
      await codex(server, 'UserPromptSubmit', { prompt: 'codex task' })
      server.endLaunchAuthority(PANE, 'codex')
      expect(row(server)).toMatchObject({ providerSessionOnly: true, agentType: 'codex' })
      await codex(server, late, late === 'PostToolUse' ? toolUse : {})
      expect(row(server)).toMatchObject({ providerSessionOnly: true })
      await codex(server, 'UserPromptSubmit', { prompt: 'next task' })
      expect(row(server)).toMatchObject({
        state: 'working',
        agentType: 'codex',
        prompt: 'next task'
      })
    }
  )

  it('keeps the remnant of a launch that already exited, in place', async () => {
    const server = await createServer()
    await claude(server, 'UserPromptSubmit', { prompt: 'claude task' })
    await claude(server, 'SessionEnd', { reason: 'prompt_input_exit' })
    const remnant = row(server)
    server.endLaunchAuthority(PANE, 'claude')
    expect(row(server)).toEqual(remnant)
  })

  it('resets a pane whose row has no owner record, as before', async () => {
    const server = await createServer()
    server.ingestTerminalStatus({
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      payload: { state: 'working', prompt: '', agentType: 'claude' }
    })
    server.endLaunchAuthority(PANE, 'claude')
    expect(row(server)).toBeUndefined()
    await codex(server, 'PreToolUse', toolUse)
    expect(row(server)).toBeUndefined()
    await codex(server, 'UserPromptSubmit', { prompt: 'next task' })
    expect(row(server)).toMatchObject({ agentType: 'codex', prompt: 'next task' })
  })

  it("never lets the ended launch's inherited token attest again, late hook or new run", async () => {
    const server = await createServer()
    const tokenHash = createHash('sha256').update('launch-token').digest('hex')
    const attest = () =>
      server.attestCompatibilityAuthority({
        paneKey: PANE,
        launchTokenHash: tokenHash,
        connectionId: null,
        terminalProvenance: 'current_runtime'
      })
    const post = async (event: string, extra = {}) => {
      const body = buildBody(
        { hook_event_name: event, session_id: 'codex-x', ...extra },
        { launchToken: 'launch-token' }
      )
      expect((await postHookEvent(server, body, '/hook/codex')).status).toBe(204)
    }
    await post('UserPromptSubmit', { prompt: 'codex task' })
    expect(attest()).not.toBeNull()
    server.endLaunchAuthority(PANE, 'codex')
    expect(attest()).toBeNull()
    await post('Stop')
    expect(attest()).toBeNull()
    await post('UserPromptSubmit', { prompt: 'next task' })
    expect(row(server)).toMatchObject({ prompt: 'next task' })
    expect(attest()).toBeNull()
  })

  it("keeps an ended launch's token fenced when its pane moves to another tab", async () => {
    const server = await createServer()
    const movedPane = makePaneKey('tab-2', LEAF_2)
    const tokenHash = createHash('sha256').update('launch-token').digest('hex')
    const attest = (paneKey: string) =>
      server.attestCompatibilityAuthority({
        paneKey,
        launchTokenHash: tokenHash,
        connectionId: null,
        terminalProvenance: 'current_runtime'
      })
    const post = async (event: string, extra = {}) => {
      const body = buildBody(
        { hook_event_name: event, session_id: 'codex-x', ...extra },
        { launchToken: 'launch-token' }
      )
      expect((await postHookEvent(server, body, '/hook/codex')).status).toBe(204)
    }
    await post('UserPromptSubmit', { prompt: 'codex task' })
    server.endLaunchAuthority(PANE, 'codex')
    server.transferPaneAuthority(PANE, movedPane, 'pty-moved')
    await post('UserPromptSubmit', { prompt: 'next task' })
    expect(attest(movedPane)).toBeNull()
  })
})
