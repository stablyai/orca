import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from './server'
import { makePaneKey } from '../../shared/stable-pane-id'
import { buildBody, LEAF_1, PANE, postHookEvent } from './server.test-fixtures'

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

// #24353: a remote worker's liveness reads the exit after the hook store has reconciled the row.
describe('retained agent exit', () => {
  it('keeps a SessionEnd exit readable after the row is reconciled', async () => {
    const server = await createServer()
    const attachedAt = Date.now() - 1
    await hook(server, 'SessionStart')
    await hook(server, 'SessionEnd', 'session-a', 'prompt_input_exit')
    expect(await server.checkAgentPresence(PANE)).toBeNull()
    expect(await server.checkAgentPresenceSince(PANE, attachedAt)).toBe('exited')
  })

  it('keeps a probed exit readable on every later read', async () => {
    const server = await createServer()
    const attachedAt = Date.now() - 1
    await hook(server, 'SessionStart')
    probe.mockResolvedValue('exited')
    expect(await server.checkAgentPresence(PANE)).toBe('exited')
    expect(await server.checkAgentPresenceSince(PANE, attachedAt)).toBe('exited')
    expect(await server.checkAgentPresenceSince(PANE, attachedAt)).toBe('exited')
  })

  it('ignores an exit from before the reader attached', async () => {
    const server = await createServer()
    await hook(server, 'SessionStart')
    await hook(server, 'SessionEnd', 'session-a', 'prompt_input_exit')
    expect(await server.checkAgentPresenceSince(PANE, Date.now() + 60_000)).toBeNull()
  })

  it('keeps the exit through a late terminal status with no process identity', async () => {
    const server = await createServer()
    const attachedAt = Date.now() - 1
    await hook(server, 'SessionStart')
    await hook(server, 'UserPromptSubmit')
    await hook(server, 'SessionEnd', 'session-a', 'prompt_input_exit')
    server.ingestTerminalStatus({
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      connectionId: null,
      payload: { state: 'done', prompt: 'session-a task', agentType: 'claude' }
    })
    expect(await server.checkAgentPresenceSince(PANE, attachedAt)).toBe('exited')
  })

  it('keeps the exit through a late terminal status from another provider', async () => {
    const server = await createServer()
    const attachedAt = Date.now() - 1
    await hook(server, 'SessionStart')
    await hook(server, 'SessionEnd', 'session-a', 'prompt_input_exit')
    server.ingestTerminalStatus({
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      connectionId: null,
      payload: { state: 'done', prompt: '', agentType: 'codex' }
    })
    expect(await server.checkAgentPresenceSince(PANE, attachedAt)).toBe('exited')
  })

  it('carries the exit with the pane when its authority moves', async () => {
    const server = await createServer()
    const attachedAt = Date.now() - 1
    const moved = makePaneKey('tab-moved', LEAF_1)
    await hook(server, 'SessionStart')
    await hook(server, 'SessionEnd', 'session-a', 'prompt_input_exit')
    server.transferPaneAuthority(PANE, moved)
    expect(await server.checkAgentPresenceSince(moved, attachedAt)).toBe('exited')
    expect(await server.checkAgentPresenceSince(PANE, attachedAt)).toBe('exited')
  })

  it('keeps the exit readable through both keys when the pane moved before it ended', async () => {
    const server = await createServer()
    const attachedAt = Date.now() - 1
    const moved = makePaneKey('tab-moved', LEAF_1)
    await hook(server, 'SessionStart')
    server.transferPaneAuthority(PANE, moved)
    await hook(server, 'SessionEnd', 'session-a', 'prompt_input_exit')
    expect(await server.checkAgentPresenceSince(moved, attachedAt)).toBe('exited')
    expect(await server.checkAgentPresenceSince(PANE, attachedAt)).toBe('exited')
  })

  it('drops the exit once an agent without a process identity reports from the pane', async () => {
    const server = await createServer()
    const attachedAt = Date.now() - 1
    await hook(server, 'SessionStart')
    await hook(server, 'SessionEnd', 'session-a', 'prompt_input_exit')
    await hook(server, 'UserPromptSubmit', 'replacement', undefined, null)
    expect(await server.checkAgentPresenceSince(PANE, attachedAt)).toBeNull()
  })

  it('drops the exit once a hookless agent run starts its process-lifetime turn', async () => {
    const server = await createServer()
    const attachedAt = Date.now() - 1
    await hook(server, 'SessionStart')
    await hook(server, 'SessionEnd', 'session-a', 'prompt_input_exit')
    server.ingestTerminalStatus({
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      connectionId: null,
      origin: 'process',
      yieldsToHookSince: Date.now(),
      payload: { state: 'working', prompt: '', agentType: 'opencode' }
    })
    expect(await server.checkAgentPresenceSince(PANE, attachedAt)).toBeNull()
  })

  it('does not retain an old owner death proved by a live replacement hook', async () => {
    const server = await createServer()
    const attachedAt = Date.now() - 1
    await hook(server, 'SessionStart')
    probe.mockResolvedValue('exited')
    await hook(server, 'SessionStart', 'replacement', undefined, 4002)
    await vi.waitFor(() => expect(probe).toHaveBeenCalled())
    probe.mockResolvedValue('live')
    await vi.waitFor(async () =>
      expect(await server.checkAgentPresenceSince(PANE, attachedAt)).not.toBe('exited')
    )
    expect(await server.checkAgentPresenceSince(PANE, attachedAt)).not.toBe('exited')
  })

  it('does not answer exited to a read overlapping the replacement-triggered probe', async () => {
    const server = await createServer()
    const attachedAt = Date.now() - 1
    await hook(server, 'SessionStart')
    let finish: (verdict: 'exited') => void = () => {}
    probe.mockImplementationOnce(
      () =>
        new Promise<'live' | 'unverifiable' | 'exited'>((resolve) => {
          finish = resolve
        })
    )
    await hook(server, 'SessionStart', 'replacement', undefined, 4002)
    const overlapping = server.checkAgentPresenceSince(PANE, attachedAt)
    finish('exited')
    expect(await overlapping).not.toBe('exited')
  })

  it('keeps the exit through a delayed hook from the ended session without a process identity', async () => {
    const server = await createServer()
    const attachedAt = Date.now() - 1
    await hook(server, 'SessionStart')
    await hook(server, 'SessionEnd', 'session-a', 'prompt_input_exit')
    await hook(server, 'Stop', 'session-a', undefined, null)
    expect(await server.checkAgentPresenceSince(PANE, attachedAt)).toBe('exited')
  })

  it('drops the exit when a provider-specific new turn starts in the pane', async () => {
    const server = await createServer()
    const attachedAt = Date.now() - 1
    await hook(server, 'SessionStart')
    await hook(server, 'SessionEnd', 'session-a', 'prompt_input_exit')
    const response = await postHookEvent(
      server,
      buildBody({ hook_event_name: 'before_agent_start', prompt: 'next' }),
      '/hook/pi'
    )
    expect(response.status).toBe(204)
    expect(await server.checkAgentPresenceSince(PANE, attachedAt)).toBeNull()
  })

  it('drops the exit when another provider reports from the pane without a new-turn event', async () => {
    const server = await createServer()
    const attachedAt = Date.now() - 1
    await hook(server, 'SessionStart')
    await hook(server, 'SessionEnd', 'session-a', 'prompt_input_exit')
    const response = await postHookEvent(
      server,
      buildBody({ hook_event_name: 'agent_start', prompt: 'next' }),
      '/hook/pi'
    )
    expect(response.status).toBe(204)
    expect(await server.checkAgentPresenceSince(PANE, attachedAt)).toBeNull()
  })

  it('keeps a persisted exit through a spooled start written before it', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-presence-exit-spool-'))
    const first = new AgentHookServer()
    servers.push(first)
    await first.start({ env: 'production', userDataPath })
    const attachedAt = Date.now() - 1
    // Spool stamps are whole seconds, so only one a full second before the exit predates it.
    const spooledAt = Date.now() - 5_000
    await hook(first, 'SessionStart')
    await hook(first, 'SessionEnd', 'session-a', 'prompt_input_exit')
    first.flushStatusPersistSync()
    first.stop()
    const spoolDir = join(userDataPath, 'agent-hooks', 'spool')
    mkdirSync(spoolDir, { recursive: true })
    writeFileSync(
      join(spoolDir, 'pane-spooled.jsonl'),
      `\n${JSON.stringify({
        paneKey: PANE,
        source: 'claude',
        receivedAt: spooledAt,
        // An obsolete owner identity must not be installed over the proven exit.
        agentProcess: JSON.stringify({
          pid: 4009,
          platform: process.platform,
          startTime: 'birth-4009'
        }),
        payload: { hook_event_name: 'SessionStart', session_id: 'session-old', source: 'startup' }
      })}\n`
    )
    const restarted = new AgentHookServer()
    servers.push(restarted)
    await restarted.start({ env: 'production', userDataPath })
    expect(await restarted.checkAgentPresenceSince(PANE, attachedAt)).toBe('exited')
  })

  it('lets a successor start spooled in the exit second clear the exit', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-presence-exit-same-second-'))
    const first = new AgentHookServer()
    servers.push(first)
    await first.start({ env: 'production', userDataPath })
    const attachedAt = Date.now() - 1
    await hook(first, 'SessionStart')
    await hook(first, 'SessionEnd', 'session-a', 'prompt_input_exit')
    first.flushStatusPersistSync()
    first.stop()
    const spoolDir = join(userDataPath, 'agent-hooks', 'spool')
    mkdirSync(spoolDir, { recursive: true })
    writeFileSync(
      join(spoolDir, 'pane-spooled.jsonl'),
      `\n${JSON.stringify({
        paneKey: PANE,
        source: 'pi',
        receivedAt: Math.floor(Date.now() / 1000) * 1000,
        payload: { hook_event_name: 'before_agent_start', prompt: 'next' }
      })}\n`
    )
    const restarted = new AgentHookServer()
    servers.push(restarted)
    await restarted.start({ env: 'production', userDataPath })
    expect(await restarted.checkAgentPresenceSince(PANE, attachedAt)).not.toBe('exited')
  })

  it('lets a replacement process clear the exit after a late unidentified hook', async () => {
    const server = await createServer()
    const attachedAt = Date.now() - 1
    await hook(server, 'SessionStart')
    await hook(server, 'SessionEnd', 'session-a', 'prompt_input_exit')
    await hook(server, 'Stop', 'session-a', undefined, null)
    probe.mockResolvedValue('live')
    await hook(server, 'PreToolUse', 'replacement', undefined, 4002)
    expect(await server.checkAgentPresenceSince(PANE, attachedAt)).not.toBe('exited')
  })

  it('keeps the exit readable after the hook store restarts', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-presence-exit-'))
    const first = new AgentHookServer()
    servers.push(first)
    await first.start({ env: 'production', userDataPath })
    const attachedAt = Date.now() - 1
    await hook(first, 'SessionStart')
    await hook(first, 'SessionEnd', 'session-a', 'prompt_input_exit')
    first.flushStatusPersistSync()
    first.stop()
    const restarted = new AgentHookServer()
    servers.push(restarted)
    await restarted.start({ env: 'production', userDataPath })
    expect(await restarted.checkAgentPresenceSince(PANE, attachedAt)).toBe('exited')
  })

  it('forgets an earlier exit when a worker attaches to the pane', async () => {
    const server = await createServer()
    await hook(server, 'SessionStart')
    await hook(server, 'SessionEnd', 'session-a', 'prompt_input_exit')
    server.forgetAgentExit(PANE)
    expect(await server.checkAgentPresenceSince(PANE, 0)).toBeNull()
  })

  it('drops the exit once a new agent reports from the pane', async () => {
    const server = await createServer()
    const attachedAt = Date.now() - 1
    await hook(server, 'SessionStart')
    await hook(server, 'SessionEnd', 'session-a', 'prompt_input_exit')
    await hook(server, 'SessionStart', 'relaunch', undefined, 4002)
    probe.mockResolvedValue('live')
    expect(await server.checkAgentPresenceSince(PANE, attachedAt)).toBe('live')
  })
})

describe('retained agent exit lifetime', () => {
  async function serverWithExit(): Promise<AgentHookServer> {
    const server = await createServer()
    await hook(server, 'SessionStart')
    await hook(server, 'SessionEnd', 'session-a', 'prompt_input_exit')
    expect(await server.checkAgentPresenceSince(PANE, 0)).toBe('exited')
    return server
  }

  it('keeps the exit through a plain pane cleanup but drops it when the PTY retires', async () => {
    const server = await serverWithExit()
    server.clearPaneState(PANE)
    expect(await server.checkAgentPresenceSince(PANE, 0)).toBe('exited')
    server.clearPaneState(PANE, { forgetAgentExit: true })
    expect(await server.checkAgentPresenceSince(PANE, 0)).toBeNull()
  })

  it('drops the exit when the pane tab closes', async () => {
    const server = await serverWithExit()
    server.dropStatusEntriesByTabPrefix('tab-1')
    expect(await server.checkAgentPresenceSince(PANE, 0)).toBeNull()
  })

  it('keeps a moved pane exit when its former tab closes', async () => {
    const server = await serverWithExit()
    const moved = makePaneKey('tab-moved', LEAF_1)
    server.transferPaneAuthority(PANE, moved)
    server.dropStatusEntriesByTabPrefix('tab-1')
    expect(await server.checkAgentPresenceSince(moved, 0)).toBe('exited')
    server.dropStatusEntriesByTabPrefix('tab-moved')
    expect(await server.checkAgentPresenceSince(moved, 0)).toBeNull()
  })

  // Why: a finished shell command retires launch authority while the PTY, and the exit's meaning, survive.
  it('keeps the exit when only the pane launch authority retires', async () => {
    const server = await serverWithExit()
    server.retirePaneAuthority(PANE)
    expect(await server.checkAgentPresenceSince(PANE, 0)).toBe('exited')
  })

  it('prunes an exit older than the hydrate window when saving', async () => {
    const server = new AgentHookServer()
    servers.push(server)
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-presence-exit-prune-'))
    await server.start({ env: 'production', userDataPath })
    await hook(server, 'SessionStart')
    await hook(server, 'SessionEnd', 'session-a', 'prompt_input_exit')
    expect(await server.checkAgentPresenceSince(PANE, 0)).toBe('exited')
    const saveEightDaysLater = (): void => {
      const now = Date.now()
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 8 * 24 * 60 * 60 * 1000)
      try {
        server.flushStatusPersistSync()
      } finally {
        clock.mockRestore()
      }
    }
    // The retained resume row still names the session, so its exit must stay with it.
    expect(server.getStatusSnapshot().some((row) => row.paneKey === PANE)).toBe(true)
    saveEightDaysLater()
    expect(await server.checkAgentPresenceSince(PANE, 0)).toBe('exited')
    server.clearPaneState(PANE)
    saveEightDaysLater()
    expect(await server.checkAgentPresenceSince(PANE, 0)).toBeNull()
  })
})
