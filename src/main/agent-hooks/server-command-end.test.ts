import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from './server'
import { buildBody, LEAF_2, PANE, postHookEvent } from './server.test-fixtures'
import { makePaneKey } from '../../shared/stable-pane-id'
import { wslHookRelayConnectionId } from '../../shared/wsl-hook-relay-contract'
import type { CommandForeground, FinishedCommand } from '../../shared/command-foreground-tracker'

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

/** A command that started before the pane's rows and finished now, with this foreground. */
function finished(
  foreground: CommandForeground,
  startedAt: number | null = 0,
  promptReturned = true
): FinishedCommand {
  return {
    foreground,
    startedAt,
    finishedAt: Date.now() + 1,
    promptReturned: async () => promptReturned
  }
}
const ran = (agent: string) => finished({ kind: 'agent', agent })

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

describe('the host ending the agent a finished command ran', () => {
  it('keeps a waiting guest visible, with its prompt, when a launched Claude is killed (e2e i)', async () => {
    const server = await createServer()
    await claude(server, 'UserPromptSubmit', { prompt: 'claude task' })
    await codex(server, 'UserPromptSubmit', { prompt: 'codex task' })
    await vi.waitFor(() => expect(probe).toHaveBeenCalledOnce())
    probe.mockResolvedValue('exited')
    // The command-finished recheck proves Claude gone; the held Codex takes the pane.
    await server.checkAgentPresence(PANE)
    expect(row(server)).toMatchObject({ agentType: 'codex', prompt: 'codex task' })
    await server.endCommand(PANE, ran('claude'))
    expect(row(server)).toMatchObject({ agentType: 'codex', prompt: 'codex task' })
    await codex(server, 'PreToolUse', toolUse)
    expect(row(server)).toMatchObject({
      agentType: 'codex',
      prompt: 'codex task',
      toolName: 'Bash'
    })
  })

  it('leaves an owner with a process to the process check (a killed typed Claude ends there)', async () => {
    const server = await createServer()
    await claude(server, 'UserPromptSubmit', { prompt: 'claude task' })
    await server.endCommand(PANE, ran('claude'))
    expect(row(server)).toMatchObject({ state: 'working' })
    probe.mockResolvedValue('exited')
    await server.checkAgentPresence(PANE)
    expect(row(server)).toMatchObject({
      providerSessionOnly: true,
      providerSession: { id: 'claude-a' }
    })
  })

  it.each([
    ['its foreground was Codex (Ctrl-C, Ctrl-Z)', () => ran('codex')],
    [
      'nothing named the foreground, and Codex reported during it',
      () => finished({ kind: 'unknown' })
    ]
  ])('ends a typed Codex when %s; its late hooks never revive it', async (_, command) => {
    const server = await createServer()
    await codex(server, 'UserPromptSubmit', { prompt: 'codex task' })
    await server.endCommand(PANE, command())
    expect(row(server)).toMatchObject({ providerSessionOnly: true, agentType: 'codex' })
    await codex(server, 'Stop')
    expect(row(server)).toMatchObject({ providerSessionOnly: true })
    await codex(server, 'UserPromptSubmit', { prompt: 'next task' })
    expect(row(server)).toMatchObject({ state: 'working', prompt: 'next task' })
  })

  it.each([
    [
      'another program held the foreground (`codex &`, then `ls`)',
      () => finished({ kind: 'program' })
    ],
    ['another agent held it', () => ran('claude')],
    ['it reported only before the command', () => finished({ kind: 'unknown' }, Date.now() + 1)]
  ])('keeps a Codex when %s', async (_, command) => {
    const server = await createServer()
    await codex(server, 'UserPromptSubmit', { prompt: 'codex task' })
    await server.endCommand(PANE, command())
    expect(row(server)).toMatchObject({ state: 'working', agentType: 'codex' })
  })

  it('keeps a Codex when a fresh read finds a non-shell holding the terminal (a leaked end)', async () => {
    const server = await createServer()
    await codex(server, 'UserPromptSubmit', { prompt: 'codex task' })
    await server.endCommand(PANE, finished({ kind: 'agent', agent: 'codex' }, 0, false))
    expect(row(server)).toMatchObject({ state: 'working', agentType: 'codex' })
  })

  it("keeps a row reported after the command finished (a run's own Done)", async () => {
    const server = await createServer()
    await codex(server, 'UserPromptSubmit', { prompt: 'codex task' })
    await server.endCommand(PANE, { ...ran('codex'), finishedAt: 0 })
    expect(row(server)).toMatchObject({ state: 'working' })
  })

  it('clears a row with no owner record when its agent ran the command', async () => {
    const server = await createServer()
    server.ingestTerminalStatus({
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      payload: { state: 'working', prompt: '', agentType: 'aider' }
    })
    await server.endCommand(PANE, ran('codex'))
    expect(row(server)).toMatchObject({ state: 'working' })
    await server.endCommand(PANE, ran('aider'))
    expect(row(server)).toBeUndefined()
  })

  it('clears a row painted from output when its printing command ends under a program (e2e viii)', async () => {
    const server = await createServer()
    server.ingestTerminalStatus({
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      payload: { state: 'working', prompt: 'osc only', agentType: 'opencode' }
    })
    await server.endCommand(PANE, finished({ kind: 'program' }))
    expect(row(server)).toBeUndefined()
  })

  it('leaves an SSH row to its relay, and ends a WSL row, which this machine executes', async () => {
    const ssh = await createServer()
    relayed(ssh, 'ssh-1')
    await ssh.endCommand(PANE, ran('codex'))
    expect(row(ssh)).toMatchObject({ state: 'working' })
    const wsl = await createServer()
    relayed(wsl, wslHookRelayConnectionId('Ubuntu'))
    await wsl.endCommand(PANE, finished({ kind: 'unknown' }))
    expect(row(wsl)).toMatchObject({ providerSessionOnly: true })
  })

  it('clears an SSH row painted only from terminal output, which no relay holds', async () => {
    const server = await createServer()
    server.ingestTerminalStatus({
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      connectionId: 'ssh-1',
      payload: { state: 'working', prompt: '', agentType: 'codex' }
    })
    expect(row(server)).toMatchObject({ state: 'working', connectionId: 'ssh-1' })
    // Main cannot read an SSH foreground: the row reported during the command, so it ends.
    await server.endCommand(PANE, finished({ kind: 'unknown' }))
    expect(row(server)).toBeUndefined()
  })

  it('fences a session-less agent, then admits its new run once its process shows', async () => {
    const server = await createServer()
    const commandCode = (event: string) =>
      postHookEvent(server, buildBody({ hook_event_name: event, ...toolUse }), '/hook/command-code')
    await commandCode('PreToolUse')
    await server.endCommand(PANE, ran('command-code'))
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
    expect(row(server)).toMatchObject({ state: 'working', agentType: 'command-code' })
  })

  it("never lets an ended launch's inherited token attest again, late hook or new run", async () => {
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
    server.endLaunchAuthority(PANE)
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
    const post = async (event: string, extra = {}) => {
      const body = buildBody(
        { hook_event_name: event, session_id: 'codex-x', ...extra },
        { launchToken: 'launch-token' }
      )
      expect((await postHookEvent(server, body, '/hook/codex')).status).toBe(204)
    }
    await post('UserPromptSubmit', { prompt: 'codex task' })
    server.endLaunchAuthority(PANE)
    server.transferPaneAuthority(PANE, movedPane, 'pty-moved')
    await post('UserPromptSubmit', { prompt: 'next task' })
    expect(
      server.attestCompatibilityAuthority({
        paneKey: movedPane,
        launchTokenHash: tokenHash,
        connectionId: null,
        terminalProvenance: 'current_runtime'
      })
    ).toBeNull()
  })
})
