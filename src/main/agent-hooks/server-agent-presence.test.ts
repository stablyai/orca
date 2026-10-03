import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from './server'
import { buildBody, PANE, postHookEvent } from './server.test-fixtures'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))

const probe = vi.hoisted(() =>
  vi.fn(async (): Promise<'live' | 'unverifiable' | 'exited'> => 'unverifiable')
)
vi.mock('../../shared/agent-process-presence-probe', () => ({
  probeAgentProcessPresence: probe,
  isSuspendedAgentProcess: vi.fn(async () => false)
}))
const servers: AgentHookServer[] = []
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop()
  }
  probe.mockReset()
  probe.mockResolvedValue('unverifiable')
})

class PresenceTestServer extends AgentHookServer {
  applyTranscriptUpdate(): void {
    const row = this.state.lastStatusByPaneKey.get(PANE)
    if (row) {
      this.applyNormalizedStatus({
        ...row,
        payload: { ...row.payload, lastAssistantMessage: 'late transcript result' }
      })
    }
  }
}

async function createServer(): Promise<PresenceTestServer> {
  const server = new PresenceTestServer()
  servers.push(server)
  await server.start({ env: 'production' })
  return server
}

async function hook(
  server: AgentHookServer,
  event: string,
  session = 'session-a',
  reason?: string,
  pid: number | null = 4001
): Promise<void> {
  const agentProcess =
    pid === null
      ? undefined
      : JSON.stringify({ pid, platform: process.platform, startTime: `birth-${pid}` })
  const response = await postHookEvent(
    server,
    buildBody(
      {
        hook_event_name: event,
        session_id: session,
        source: 'startup',
        reason,
        ...(event === 'UserPromptSubmit' ? { prompt: `${session} task` } : {})
      },
      { agentProcess }
    )
  )
  expect(response.status).toBe(204)
}

function capture(server: AgentHookServer, pid = 4001): void {
  server.ingestForegroundPresence(
    { paneKey: PANE, tabId: 'tab-1', worktreeId: 'wt-1', connectionId: null },
    {
      agent: 'claude',
      process: { pid, platform: 'darwin', startTime: `birth-${pid}` }
    }
  )
}

function state(server: AgentHookServer): string | null {
  const row = server.getStatusSnapshot().find((entry) => entry.paneKey === PANE)
  return row && !row.providerSessionOnly ? row.state : null
}

function visible(server: AgentHookServer): boolean {
  return server.getStatusSnapshot().some((row) => row.paneKey === PANE && !row.providerSessionOnly)
}

describe('host-owned hook presence', () => {
  it('checks the owner on an exit hook and clears once the check proves the exit', async () => {
    const server = await createServer()
    await hook(server, 'SessionStart')
    capture(server)
    expect(visible(server)).toBe(true)
    await hook(server, 'SessionEnd', 'session-a', 'prompt_input_exit')
    // A live owner is checked, never trusted: an exit hook runs while the process still lives.
    expect(visible(server)).toBe(true)
    probe.mockResolvedValueOnce('exited')
    await hook(server, 'SessionEnd', 'session-a', 'prompt_input_exit')
    await vi.waitFor(() => expect(visible(server)).toBe(false))
  })

  it('ends its own turn on an exit hook when no owner can be checked (tmux, WSL)', async () => {
    const server = await createServer()
    await hook(server, 'SessionStart')
    await hook(server, 'UserPromptSubmit')
    expect(state(server)).toBe('working')
    await hook(server, 'SessionEnd', 'session-a', 'clear')
    expect(visible(server)).toBe(true)
    await hook(server, 'SessionEnd', 'other-session', 'prompt_input_exit')
    expect(visible(server)).toBe(true)
    await hook(server, 'SessionEnd', 'session-a', 'prompt_input_exit')
    expect(visible(server)).toBe(false)
  })

  it('never mints or resurrects a Done from a Claude exit hook', async () => {
    const server = await createServer()
    await hook(server, 'SessionEnd', 'session-a', 'prompt_input_exit')
    expect(server.getStatusSnapshot()).toEqual([])
    await hook(server, 'UserPromptSubmit')
    await hook(server, 'Stop')
    server.dropStatusEntry(PANE)
    expect(visible(server)).toBe(false)
    await hook(server, 'SessionEnd', 'session-a', 'prompt_input_exit')
    expect(visible(server)).toBe(false)
  })

  it.each(['clear', 'resume'])('keeps the running process present through %s', async (reason) => {
    const server = await createServer()
    await hook(server, 'SessionStart')
    capture(server)
    await hook(server, 'SessionEnd', 'session-a', reason)
    expect(visible(server)).toBe(true)
    await hook(server, 'UserPromptSubmit', 'session-b')
    expect(state(server)).toBe('working')
    probe.mockResolvedValueOnce('exited')
    await hook(server, 'SessionEnd', 'session-b', 'prompt_input_exit')
    await vi.waitFor(() => expect(visible(server)).toBe(false))
  })

  it('treats a hook after the owner exited as a turn of whatever runs now', async () => {
    const server = await createServer()
    await hook(server, 'SessionStart')
    capture(server)
    probe.mockResolvedValueOnce('exited')
    expect(await server.checkAgentPresence(PANE)).toBe('exited')
    expect(visible(server)).toBe(false)
    await hook(server, 'Stop')
    expect(visible(server)).toBe(true)
    // The exited owner is superseded by the new turn rather than labelling it.
    expect(server.getAgentOwner(PANE)).toBeUndefined()
  })

  it('keeps the pane owned by its agent while a nested agent in it starts and ends', async () => {
    const server = await createServer()
    await hook(server, 'SessionStart', 'outer')
    capture(server)
    await hook(server, 'UserPromptSubmit', 'outer')
    await hook(server, 'SessionStart', 'nested', undefined, 4002)
    await hook(server, 'UserPromptSubmit', 'nested', undefined, 4002)
    await hook(server, 'SessionEnd', 'nested', 'other', 4002)
    expect(visible(server)).toBe(true)
    await hook(server, 'PostToolUse', 'outer')
    expect(state(server)).toBe('working')
    probe.mockResolvedValueOnce('exited')
    await hook(server, 'SessionEnd', 'outer', 'other')
    await vi.waitFor(() => expect(visible(server)).toBe(false))
  })

  it('ends only the turn of the session that exits; the outer agent reports on', async () => {
    const server = await createServer()
    await hook(server, 'SessionStart', 'outer', undefined, null)
    await hook(server, 'UserPromptSubmit', 'outer', undefined, null)
    await hook(server, 'SessionEnd', 'nested', 'other', null)
    expect(state(server)).toBe('working')
    // A nested run whose SessionStart took over the row ends that row, not the outer agent.
    await hook(server, 'SessionStart', 'nested', undefined, null)
    await hook(server, 'SessionEnd', 'nested', 'other', null)
    expect(visible(server)).toBe(false)
    await hook(server, 'PostToolUse', 'outer', undefined, null)
    expect(state(server)).toBe('working')
  })

  it('lets an unidentified agent keep reporting after an identified nested agent ends', async () => {
    const server = await createServer()
    await hook(server, 'UserPromptSubmit', 'outer', undefined, null)
    await hook(server, 'SessionStart', 'nested', undefined, 4002)
    await hook(server, 'SessionEnd', 'nested', 'other', 4002)
    await hook(server, 'PostToolUse', 'outer', undefined, null)
    expect(state(server)).toBe('working')
    expect(await server.checkAgentPresence(PANE)).toBeNull()
  })

  it('does not let a Claude started inside a working Codex turn end the pane', async () => {
    const server = await createServer()
    const base = { paneKey: PANE, tabId: 'tab-1', worktreeId: 'wt-1' }
    server.ingestRemote(
      {
        ...base,
        source: 'codex',
        hookEventName: 'UserPromptSubmit',
        payload: { state: 'working', prompt: 'codex task', agentType: 'codex' }
      },
      'ssh-1'
    )
    // The relay has no identity resolution, so it can hand the nested Claude ownership.
    server.ingestRemote(
      {
        ...base,
        source: 'claude',
        hookEventName: 'SessionEnd',
        providerSessionOnly: true,
        agentPresence: {
          agent: 'claude',
          process: { pid: 4002, platform: 'linux', startTime: 'boot:1' },
          ended: true
        },
        payload: { state: 'done', prompt: '', agentType: 'claude' }
      },
      'ssh-1'
    )
    expect(state(server)).toBe('working')
  })

  it.each([
    ['working', []],
    ['idle', ['Stop']]
  ])('keeps a %s Codex pane when a Claude run inside it ends', async (_label, codexTail) => {
    const server = await createServer()
    const codex = async (event: string) => {
      const response = await postHookEvent(
        server,
        buildBody({ hook_event_name: event, session_id: 'codex-a', prompt: 'task' }),
        '/hook/codex'
      )
      expect(response.status).toBe(204)
    }
    await codex('UserPromptSubmit')
    for (const event of codexTail) {
      await codex(event)
    }
    const before = state(server)
    await hook(server, 'SessionStart', 'nested', undefined, 4002)
    await hook(server, 'UserPromptSubmit', 'nested', undefined, 4002)
    await hook(server, 'SessionEnd', 'nested', 'other', 4002)
    // A working Codex turn survives; an idle one the nested run took over ends with that run.
    expect(visible(server)).toBe(_label === 'working')
    expect(before).not.toBeNull()
    expect(await server.checkAgentPresence(PANE)).toBeNull()
  })

  it.each(['devin', 'qoder', 'codebuddy', 'copilot'])(
    'settles %s to done on its own SessionEnd hook',
    async (agent) => {
      const server = await createServer()
      const post = async (payload: Record<string, unknown>) => {
        const response = await postHookEvent(
          server,
          buildBody({ session_id: `${agent}-a`, ...payload }),
          `/hook/${agent}`
        )
        expect(response.status).toBe(204)
      }
      await post({ hook_event_name: 'UserPromptSubmit', prompt: 'do the task' })
      expect(state(server)).toBe('working')
      await post({ hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' })
      expect(state(server)).toBe('done')
    }
  )

  it('reports a checkable agent process only for an identified, running owner', async () => {
    const server = await createServer()
    expect(server.hasVerifiableAgentProcess(PANE)).toBe(false)
    await hook(server, 'SessionStart', 'unidentified', undefined, null)
    expect(server.hasVerifiableAgentProcess(PANE)).toBe(false)
    const identified = await createServer()
    await hook(identified, 'SessionStart')
    capture(identified)
    expect(identified.hasVerifiableAgentProcess(PANE)).toBe(true)
    probe.mockResolvedValueOnce('exited')
    await hook(identified, 'SessionEnd', 'session-a', 'prompt_input_exit')
    await identified.checkAgentPresence(PANE)
    expect(identified.hasVerifiableAgentProcess(PANE)).toBe(false)
  })

  it('never probes from spooled hooks an owner this runtime has not re-derived', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-presence-spool-'))
    const first = new AgentHookServer()
    servers.push(first)
    await first.start({ env: 'production', userDataPath })
    await hook(first, 'SessionStart')
    capture(first)
    first.flushStatusPersistSync()
    first.stop()
    const spoolDir = join(userDataPath, 'agent-hooks', 'spool')
    mkdirSync(spoolDir, { recursive: true })
    const agentProcess = JSON.stringify({
      pid: 4001,
      platform: process.platform,
      startTime: 'birth-4001'
    })
    const records = Array.from({ length: 40 }, (_, index) =>
      JSON.stringify({
        paneKey: PANE,
        source: 'claude',
        receivedAt: Date.now(),
        agentProcess,
        payload: {
          hook_event_name: index % 2 ? 'PreToolUse' : 'PostToolUse',
          session_id: 'session-a',
          tool_name: 'Bash',
          tool_input: { command: 'ls' }
        }
      })
    )
    writeFileSync(join(spoolDir, 'pane-spooled.jsonl'), `\n${records.join('\n')}\n`)
    probe.mockClear()
    const restarted = new AgentHookServer()
    servers.push(restarted)
    await restarted.start({ env: 'production', userDataPath })
    expect(probe).not.toHaveBeenCalled()
    expect(restarted.getAgentOwner(PANE)).toBeUndefined()
  })

  it('keeps unanswered reads and clears only a positive process exit', async () => {
    const server = await createServer()
    await hook(server, 'SessionStart')
    capture(server)
    expect(await server.checkAgentPresence(PANE)).toBe('unverifiable')
    expect(visible(server)).toBe(true)
    probe.mockResolvedValue('exited')
    expect(await server.checkAgentPresence(PANE)).toBe('exited')
    expect(visible(server)).toBe(false)
    expect(await server.checkAgentPresence(PANE)).toBeNull()
  })

  it('does not apply a delayed process exit to a relaunched agent', async () => {
    const server = await createServer()
    await hook(server, 'SessionStart')
    capture(server)
    let finish: (value: 'exited') => void = () => {}
    probe.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const pending = server.checkAgentPresence(PANE)
    server.clearPaneState(PANE, 'released')
    await hook(server, 'SessionStart', 'relaunch', undefined, 4002)
    capture(server, 4002)
    finish('exited')
    expect(await pending).toBe('unverifiable')
    expect(visible(server)).toBe(true)
  })

  it('accepts a remote exit and never probes that remote PID locally', async () => {
    const server = await createServer()
    const envelope = {
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      source: 'claude',
      hookEventName: 'SessionStart',
      providerSession: { provider: 'claude', id: 'remote-session' },
      agentPresence: {
        agent: 'claude',
        observation: { epoch: 'relay-test', sequence: 1 },
        process: { pid: process.pid, platform: process.platform, startTime: 'remote-birth' }
      },
      payload: { state: 'working', prompt: 'remote task', agentType: 'claude' }
    }
    server.ingestRemote(envelope, 'ssh-1')
    expect(visible(server)).toBe(true)
    expect(await server.checkAgentPresence(PANE)).toBe('unverifiable')
    expect(probe).not.toHaveBeenCalled()
    server.ingestRemote(
      {
        ...envelope,
        hookEventName: 'AgentProcessExit',
        providerSessionOnly: true,
        agentPresence: {
          ...envelope.agentPresence,
          observation: { epoch: 'relay-test', sequence: 2 },
          ended: true
        }
      },
      'ssh-1'
    )
    expect(visible(server)).toBe(false)
  })

  it('keeps retries ownership-neutral and waits for host proof before admitting a successor', async () => {
    const server = await createServer()
    await hook(server, 'SessionStart')
    capture(server)
    await hook(server, 'UserPromptSubmit')
    probe.mockClear()
    server.applyTranscriptUpdate()
    expect(probe).not.toHaveBeenCalled()
    await hook(server, 'UserPromptSubmit', 'relaunch', undefined, 4002)
    expect(server.getStatusSnapshot()[0]?.agentPresence?.process?.pid).toBe(4001)
    probe.mockResolvedValueOnce('exited')
    await server.checkAgentPresence(PANE)
    capture(server, 4002)
    await hook(server, 'UserPromptSubmit', 'relaunch', undefined, 4002)
    expect(server.getStatusSnapshot()[0]?.agentPresence?.process?.pid).toBe(4002)
    expect(state(server)).toBe('working')
  })
})
