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
vi.mock('../../shared/agent-process-presence-probe', () => ({ probeAgentProcessPresence: probe }))
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

function state(server: AgentHookServer): string | null {
  const row = server.getStatusSnapshot().find((entry) => entry.paneKey === PANE)
  return row && !row.providerSessionOnly ? row.state : null
}

function visible(server: AgentHookServer): boolean {
  return server.getStatusSnapshot().some((row) => row.paneKey === PANE && !row.providerSessionOnly)
}

describe('host-owned hook presence', () => {
  it('clears the status on SessionEnd while the terminal survives, without a renderer', async () => {
    const server = await createServer()
    await hook(server, 'SessionStart')
    expect(visible(server)).toBe(true)
    await hook(server, 'SessionEnd', 'session-a', 'prompt_input_exit')
    expect(visible(server)).toBe(false)
  })

  it.each(['clear', 'resume'])('keeps the running process present through %s', async (reason) => {
    const server = await createServer()
    await hook(server, 'SessionStart')
    await hook(server, 'SessionEnd', 'session-a', reason)
    expect(visible(server)).toBe(true)
    await hook(server, 'UserPromptSubmit', 'session-b')
    expect(state(server)).toBe('working')
    await hook(server, 'SessionEnd', 'session-b', 'prompt_input_exit')
    expect(visible(server)).toBe(false)
  })

  it('does not resurrect an ended process on a late Stop', async () => {
    const server = await createServer()
    await hook(server, 'SessionStart')
    await hook(server, 'SessionEnd', 'session-a', 'prompt_input_exit')
    await hook(server, 'Stop')
    expect(visible(server)).toBe(false)
  })

  it('keeps the pane owned by its agent while a nested agent in it starts and ends', async () => {
    const server = await createServer()
    await hook(server, 'SessionStart', 'outer')
    await hook(server, 'UserPromptSubmit', 'outer')
    await hook(server, 'SessionStart', 'nested', undefined, 4002)
    await hook(server, 'UserPromptSubmit', 'nested', undefined, 4002)
    await hook(server, 'SessionEnd', 'nested', 'other', 4002)
    expect(visible(server)).toBe(true)
    await hook(server, 'PostToolUse', 'outer')
    expect(state(server)).toBe('working')
    await hook(server, 'SessionEnd', 'outer', 'other')
    expect(visible(server)).toBe(false)
  })

  it('never ends a pane from a SessionEnd without a process identity', async () => {
    const server = await createServer()
    await hook(server, 'SessionStart', 'outer', undefined, null)
    await hook(server, 'UserPromptSubmit', 'outer', undefined, null)
    await hook(server, 'SessionStart', 'nested', undefined, null)
    await hook(server, 'SessionEnd', 'nested', 'other', null)
    expect(visible(server)).toBe(true)
    await hook(server, 'PostToolUse', 'outer', undefined, null)
    expect(state(server)).toBe('working')
  })

  it('lets an unidentified agent keep reporting after an identified nested agent ends', async () => {
    const server = await createServer()
    await hook(server, 'UserPromptSubmit', 'outer', undefined, null)
    await hook(server, 'SessionStart', 'nested', undefined, 4002)
    await hook(server, 'SessionEnd', 'nested', 'other', 4002)
    expect(visible(server)).toBe(true)
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
    expect(visible(server)).toBe(true)
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
    expect(identified.hasVerifiableAgentProcess(PANE)).toBe(true)
    await hook(identified, 'SessionEnd', 'session-a', 'prompt_input_exit')
    expect(identified.hasVerifiableAgentProcess(PANE)).toBe(false)
  })

  it('checks each pane once after replaying its spooled hooks', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-presence-spool-'))
    const first = new AgentHookServer()
    servers.push(first)
    await first.start({ env: 'production', userDataPath })
    await hook(first, 'SessionStart')
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
    expect(probe).toHaveBeenCalledOnce()
  })

  it('keeps unanswered reads and clears only a positive process exit', async () => {
    const server = await createServer()
    await hook(server, 'SessionStart')
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
    let finish: (value: 'exited') => void = () => {}
    probe.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const pending = server.checkAgentPresence(PANE)
    await hook(server, 'SessionEnd', 'session-a', 'prompt_input_exit')
    await hook(server, 'SessionStart', 'relaunch', undefined, 4002)
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
        agentPresence: { ...envelope.agentPresence, ended: true }
      },
      'ssh-1'
    )
    expect(visible(server)).toBe(false)
  })

  it('probes the owner only when another process reports, never on its own hooks or retries', async () => {
    const server = await createServer()
    await hook(server, 'SessionStart')
    await hook(server, 'UserPromptSubmit')
    probe.mockResolvedValue('exited')
    server.applyTranscriptUpdate()
    await Promise.resolve()
    expect(
      server.getStatusSnapshot().find((row) => row.paneKey === PANE)?.lastAssistantMessage
    ).toBe('late transcript result')
    expect(probe).not.toHaveBeenCalled()
    expect(visible(server)).toBe(true)
    await hook(server, 'SessionStart', 'relaunch', undefined, 4002)
    await vi.waitFor(() => expect(probe).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(visible(server)).toBe(false))
    await hook(server, 'UserPromptSubmit', 'relaunch', undefined, 4002)
    expect(state(server)).toBe('working')
  })
})

describe('owner presence signal for the execution host (F2)', () => {
  it('signals each owner start and end once, not every status update (R1E-2)', async () => {
    const server = await createServer()
    const changes: string[] = []
    server.subscribeAgentPresenceChanges((change) => {
      changes.push(`${change.presence?.agent}:${change.presence?.ended ? 'ended' : 'live'}`)
    })
    await hook(server, 'SessionStart')
    for (let index = 0; index < 5; index += 1) {
      await hook(server, 'PostToolUse')
    }
    await hook(server, 'SessionEnd', 'session-a', 'prompt_input_exit')
    expect(changes).toEqual(['claude:live', 'claude:ended'])
  })

  it('signals an ended owner even when another caller probed first and no row remains', async () => {
    const server = await createServer()
    await hook(server, 'SessionStart')
    const ended = vi.fn()
    server.subscribeAgentPresenceChanges((change) => {
      if (change.presence?.ended) {
        ended(change.presence.process?.pid)
      }
    })
    probe.mockResolvedValueOnce('exited')
    await expect(server.checkAgentPresence(PANE)).resolves.toBe('exited')
    // The canonical end is now recorded; a later probe answers null, yet the signal was sent.
    await expect(server.checkAgentPresence(PANE)).resolves.toBeNull()
    expect(ended).toHaveBeenCalledWith(4001)
  })

  it('signals a probed end even when no resumable remnant row survives it', async () => {
    const server = await createServer()
    // No session id: nothing to resume, so the ended owner keeps no row.
    await hook(server, 'UserPromptSubmit', '')
    const ended = vi.fn()
    server.subscribeAgentPresenceChanges((change) => {
      if (change.presence?.ended) {
        ended(change.presence.process?.pid)
      }
    })
    probe.mockResolvedValueOnce('exited')
    await expect(server.checkAgentPresence(PANE)).resolves.toBe('exited')
    expect(visible(server)).toBe(false)
    expect(ended).toHaveBeenCalledWith(4001)
  })

  it('does not treat /clear or /resume as an end', async () => {
    const server = await createServer()
    const changes: string[] = []
    server.subscribeAgentPresenceChanges((change) => {
      changes.push(change.presence?.ended ? 'ended' : 'live')
    })
    await hook(server, 'SessionStart')
    await hook(server, 'SessionEnd', 'session-a', 'clear')
    await hook(server, 'SessionEnd', 'session-a', 'resume')
    expect(changes).toEqual(['live'])
  })
})

describe('a host-proven end of an owner no hook identified (R2-4)', () => {
  async function codex(server: AgentHookServer, event: string, session: string): Promise<void> {
    const response = await postHookEvent(
      server,
      buildBody({ hook_event_name: event, session_id: session, model: 'gpt-5.4' }),
      '/hook/codex'
    )
    expect(response.status).toBe(204)
  }

  it.each([
    ['headless', false],
    ['after the desktop already dropped the row', true]
  ])(
    'ends the Codex owner so the next Codex in the shell is a new owner (%s)',
    async (_, dropped) => {
      const server = await createServer()
      const changes: string[] = []
      server.subscribeAgentPresenceChanges((change) =>
        changes.push(`${change.presence?.agent}:${change.presence?.ended ? 'ended' : 'live'}`)
      )
      await codex(server, 'SessionStart', 'codex-a')
      await codex(server, 'Stop', 'codex-a')
      if (dropped) {
        server.reconcileEndedProcessForPaneKeys([PANE], { preserveResumeIdentity: true })
      }
      server.recordHostProvenAgentEnd(PANE, 'codex', Date.now() + 1)
      expect(visible(server)).toBe(false)
      await codex(server, 'SessionStart', 'codex-b')
      expect(changes).toEqual(['codex:live', 'codex:ended', 'codex:live'])
    }
  )

  it("leaves another agent's owner and an identified owner to their own evidence", async () => {
    const server = await createServer()
    await hook(server, 'SessionStart')
    server.recordHostProvenAgentEnd(PANE, 'codex', Date.now() + 1)
    server.recordHostProvenAgentEnd(PANE, 'claude', Date.now() + 1)
    expect(state(server)).not.toBeNull()
  })

  it('never ends a newer Codex whose hook arrived while the end was being checked (R3Y-2)', async () => {
    const server = await createServer()
    await codex(server, 'SessionStart', 'codex-a')
    await codex(server, 'Stop', 'codex-a')
    const checkStartedAtMs = Date.now()
    await codex(server, 'SessionStart', 'codex-b')
    server.recordHostProvenAgentEnd(PANE, 'codex', checkStartedAtMs)
    expect(visible(server)).toBe(true)
  })
})
