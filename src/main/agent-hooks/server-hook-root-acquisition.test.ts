import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from './server'
import { buildBody, PANE, postHookEvent } from './server.test-fixtures'
import type { AgentProcessIdentity } from '../../shared/agent-process-presence'
import type { probeAgentProcessPresence } from '../../shared/agent-process-presence-probe'
import { createHookRootEvidenceReader } from '../../shared/hook-process-root-evidence'
import type { ProcessTableRow } from '../../shared/process-table-snapshot'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))

const live = new Set<number>()
const probe = vi.hoisted(() => vi.fn<typeof probeAgentProcessPresence>())
vi.mock('../../shared/agent-process-presence-probe', () => ({ probeAgentProcessPresence: probe }))

const TTY = 'ttys004'
function row(pid: number, ppid: number, pgid: number, command: string, stat = 'S+') {
  return { pid, ppid, pgid, tpgid: 49969, tty: TTY, stat, command }
}
const SHELL = row(100, 90, 100, '-zsh', 'Ss')
const CLAUDE = row(49969, 100, 49969, 'claude')
const NESTED = [
  row(49975, 49969, 49969, '/bin/zsh -c claude -p summarize'),
  row(49980, 49975, 49969, 'claude -p summarize')
]
const BACKGROUND = row(49990, 100, 49990, 'claude -p "nightly report"', 'S')
let table: ProcessTableRow[] = []
const readTable = vi.fn(async () => table)

const servers: AgentHookServer[] = []
const paths: string[] = []

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop()
  }
  for (const path of paths.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
  live.clear()
  table = []
  readTable.mockClear()
  probe.mockReset()
})

class RootTestServer extends AgentHookServer {
  presence() {
    return this.state.lastStatusByPaneKey.get(PANE)?.agentPresence
  }

  receivedAt() {
    const row = this.state.lastStatusByPaneKey.get(PANE)
    return row && 'receivedAt' in row && typeof row.receivedAt === 'number' ? row.receivedAt : 0
  }

  row() {
    return this.getStatusSnapshot().find(
      (entry) => entry.paneKey === PANE && !entry.providerSessionOnly
    )
  }
}

function startOf(pid: number): string {
  return `Sun Nov  1 00:${String(pid % 60).padStart(2, '0')}:23 2026`
}

// Shaped like the Claude hook's X-Orca-Agent-Process capture.
function capture(pid: number): AgentProcessIdentity {
  return { pid, platform: 'darwin', startTime: startOf(pid) }
}

async function createServer(userDataPath?: string): Promise<RootTestServer> {
  probe.mockImplementation(async (identity) =>
    identity && live.has(identity.pid) ? 'live' : 'unverifiable'
  )
  const server = new RootTestServer()
  servers.push(server)
  server.setHookRootEvidenceReader(createHookRootEvidenceReader({ probe, readTable }))
  await server.start({ env: 'production', ...(userDataPath ? { userDataPath } : {}) })
  return server
}

function runningPane(...rows: ProcessTableRow[]): void {
  table = [SHELL, ...rows]
  for (const entry of rows) {
    live.add(entry.pid)
  }
}

async function hook(
  server: AgentHookServer,
  event: string,
  options: {
    session?: string
    pid?: number | null
    prompt?: string
    reason?: string
    source?: string
  } = {}
): Promise<void> {
  const pid = options.pid === undefined ? 49969 : options.pid
  const response = await postHookEvent(
    server,
    buildBody(
      {
        hook_event_name: event,
        ...(event === 'SessionStart' ? { source: 'startup' } : {}),
        ...(options.session !== undefined ? { session_id: options.session } : {}),
        ...(options.reason ? { reason: options.reason } : {}),
        ...(options.prompt ? { prompt: options.prompt } : {})
      },
      pid === null ? {} : { agentProcess: JSON.stringify(capture(pid)) }
    ),
    `/hook/${options.source ?? 'claude'}`
  )
  expect(response.status).toBe(204)
}

function observe(
  server: AgentHookServer,
  state: 'working' | 'waiting' | 'done',
  agentType = 'claude',
  origin?: 'process'
): void {
  server.ingestTerminalStatus({
    paneKey: PANE,
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    connectionId: null,
    ...(origin ? { origin } : {}),
    payload: { state, prompt: '', agentType }
  })
}

describe('a pane whose recorded owner never proved a process', () => {
  it.each<[string, (server: RootTestServer) => Promise<void> | void]>([
    ['a trust prompt seen before the first hook', (server) => observe(server, 'waiting')],
    [
      'a forked resume seeded with its source session',
      (server) => {
        server.recordLaunchResumeIdentity({
          paneKey: PANE,
          worktreeId: 'wt-1',
          agentType: 'claude',
          providerSession: { key: 'session_id', id: 'fork-source' },
          launchedAt: Date.now() - 1
        })
        observe(server, 'waiting')
      }
    ],
    [
      'an owner in another session whose hooks sent no process',
      (server) => hook(server, 'UserPromptSubmit', { session: 'older', pid: null, prompt: 'old' })
    ],
    [
      'an owner in the same session whose hooks sent no process',
      (server) =>
        hook(server, 'UserPromptSubmit', { session: 'session-a', pid: null, prompt: 'old' })
    ],
    [
      'another agent that left its record in the pane',
      async (server) => {
        await hook(server, 'UserPromptSubmit', {
          session: 'cx',
          pid: null,
          prompt: 'task',
          source: 'codex'
        })
        await hook(server, 'Stop', { session: 'cx', pid: null, source: 'codex' })
      }
    ]
  ])('acquires %s from its root agent on an ordinary hook', async (_name, setup) => {
    const server = await createServer()
    runningPane(CLAUDE, ...NESTED)
    await setup(server)
    await hook(server, 'PostToolUse', { session: 'session-a' })
    expect(server.presence()).toMatchObject({
      agent: 'claude',
      process: capture(49969),
      session: 'session-a'
    })
    expect(server.row()?.providerSession?.id).toBe('session-a')
    // Once acquired, the owner's exact process keeps a nested run out of its row.
    await hook(server, 'UserPromptSubmit', { session: 'nested', pid: 49980, prompt: 'nested task' })
    expect(server.row()?.providerSession?.id).toBe('session-a')
    expect(readTable).toHaveBeenCalledOnce()
  })

  it.each([['older'], [undefined]])(
    'acquires an owner saved with session %s after a restart, from durable spool replay',
    async (session) => {
      const userDataPath = mkdtempSync(join(tmpdir(), 'orca-root-acquisition-'))
      paths.push(userDataPath)
      const first = await createServer(userDataPath)
      await hook(first, 'UserPromptSubmit', { session, pid: null, prompt: 'old' })
      first.flushStatusPersistSync()
      first.stop()
      const spoolDir = join(userDataPath, 'agent-hooks', 'spool')
      mkdirSync(spoolDir, { recursive: true })
      const record = {
        paneKey: PANE,
        source: 'claude',
        receivedAt: Date.now(),
        agentProcess: JSON.stringify(capture(49969)),
        payload: { hook_event_name: 'PostToolUse', session_id: 'session-a', tool_name: 'Bash' }
      }
      writeFileSync(join(spoolDir, 'pane-spooled.jsonl'), `\n${JSON.stringify(record)}\n`)
      runningPane(CLAUDE)
      const restarted = await createServer(userDataPath)
      expect(restarted.presence()).toMatchObject({ process: capture(49969), session: 'session-a' })
    }
  )

  it.each([['parent'], [undefined]])(
    'keeps a nested run out of an unproven owner in session %s, through its exit',
    async (session) => {
      const server = await createServer()
      runningPane(CLAUDE, ...NESTED)
      await hook(server, 'UserPromptSubmit', { session, pid: null, prompt: 'Parent task' })
      await hook(server, 'UserPromptSubmit', {
        session: 'nested',
        pid: 49980,
        prompt: 'nested task'
      })
      await hook(server, 'SessionEnd', {
        session: 'nested',
        pid: 49980,
        reason: 'prompt_input_exit'
      })
      expect(server.row()).toMatchObject({ state: 'working', prompt: 'Parent task' })
      expect(server.presence()?.process).toBeUndefined()
    }
  )

  it('keeps a background agent from taking a pane whose agent waits at its trust prompt', async () => {
    const server = await createServer()
    runningPane(CLAUDE, BACKGROUND)
    observe(server, 'waiting')
    await hook(server, 'SessionStart', { session: 'nightly', pid: 49990 })
    await hook(server, 'UserPromptSubmit', { session: 'nightly', pid: 49990, prompt: 'Nightly' })
    expect(server.row()?.state).toBe('waiting')
    expect(server.presence()).toBeUndefined()
    await hook(server, 'SessionStart', { session: 'session-a' })
    expect(server.presence()).toMatchObject({ process: capture(49969), session: 'session-a' })
  })

  it('applies an unreadable acquisition as a hook without a process, then retries on the next hook', async () => {
    const server = await createServer()
    await hook(server, 'UserPromptSubmit', { session: 'older', pid: null, prompt: 'old' })
    await hook(server, 'UserPromptSubmit', { session: 'older', prompt: 'next' })
    expect(server.row()).toMatchObject({ state: 'working', prompt: 'next' })
    expect(server.presence()).toEqual({ agent: 'claude', session: 'older' })
    runningPane(CLAUDE)
    await hook(server, 'PostToolUse', { session: 'older' })
    expect(server.presence()).toMatchObject({ process: capture(49969), session: 'older' })
  })
})

describe('terminal reports and Orca restatements', () => {
  it('lets a terminal-first Codex name its own session from its first hook', async () => {
    const server = await createServer()
    observe(server, 'working', 'codex')
    expect(server.presence()).toBeUndefined()
    await hook(server, 'UserPromptSubmit', {
      session: 'cx',
      pid: null,
      prompt: 'task',
      source: 'codex'
    })
    expect(server.presence()).toEqual({ agent: 'codex', session: 'cx' })
  })

  it('keeps a resumed Codex conversation over a Claude run inside it', async () => {
    const server = await createServer()
    runningPane(row(49969, 100, 49969, 'codex resume cx'), ...NESTED)
    server.recordLaunchResumeIdentity({
      paneKey: PANE,
      worktreeId: 'wt-1',
      agentType: 'codex',
      providerSession: { key: 'session_id', id: 'cx' },
      launchedAt: Date.now() - 1
    })
    observe(server, 'working', 'codex')
    const codex = { session: 'cx', pid: null, source: 'codex' }
    await hook(server, 'UserPromptSubmit', { ...codex, prompt: 'Codex task' })
    await hook(server, 'Stop', codex)
    await hook(server, 'UserPromptSubmit', {
      session: 'nested',
      pid: 49980,
      prompt: 'Background job'
    })
    await hook(server, 'UserPromptSubmit', { ...codex, prompt: 'Next task' })
    expect(server.row()).toMatchObject({ agentType: 'codex', prompt: 'Next task' })
    expect(server.presence()).toEqual({ agent: 'codex', session: 'cx' })
  })

  it('keeps a suspended owner through a terminal report', async () => {
    const server = await createServer()
    await hook(server, 'SessionStart', { session: 'session-a' })
    probe.mockImplementationOnce(async (_identity, _read, _platform, onSuspension) => {
      onSuspension?.(true)
      return 'unverifiable'
    })
    await server.checkAgentPresence(PANE)
    observe(server, 'working')
    expect(server.presence()).toEqual({
      agent: 'claude',
      process: capture(49969),
      session: 'session-a',
      sessionOwner: true,
      suspended: true
    })
  })

  it('never names an owner from an inferred answer', async () => {
    const server = await createServer()
    server.ingestTerminalStatus({
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      connectionId: null,
      payload: {
        state: 'waiting',
        prompt: 'pick one',
        agentType: 'claude',
        toolName: 'AskUserQuestion'
      }
    })
    const before = server.getStatusSnapshotForPane(PANE)[0]
    expect(
      server.inferQuestionAnswered({
        paneKey: PANE,
        baselineUpdatedAt: server.receivedAt(),
        baselineStateStartedAt: before.stateStartedAt,
        baselinePrompt: 'pick one',
        baselineAgentType: 'claude'
      })
    ).toBe(true)
    expect(server.presence()).toBeUndefined()
  })
})

describe('a retired owner', () => {
  it.each<[string, 'waiting' | 'working', 'process' | undefined]>([
    ['terminal', 'waiting', undefined],
    ['process-lifetime', 'working', 'process']
  ])(
    'shows the next agent through a %s report and admits only a new root',
    async (_name, state, origin) => {
      const server = await createServer()
      await hook(server, 'SessionStart', { session: 'session-a' })
      await hook(server, 'SessionEnd', { session: 'session-a', reason: 'prompt_input_exit' })
      observe(server, state, 'claude', origin)
      expect(server.row()?.state).toBe(state)
      // Late and replayed hooks from the exited process change nothing.
      await hook(server, 'Stop', { session: 'session-a' })
      await hook(server, 'SessionStart', { session: 'session-a' })
      await hook(server, 'SessionEnd', { session: 'session-a', reason: 'prompt_input_exit' })
      expect(server.row()?.state).toBe(state)
      expect(server.hasVerifiableAgentProcess(PANE)).toBe(false)
      runningPane(row(49970, 100, 49970, 'claude', 'S+'))
      table = table.map((entry) => ({ ...entry, tpgid: 49970 }))
      await hook(server, 'SessionStart', { session: 'session-b', pid: 49970 })
      expect(server.presence()).toMatchObject({ process: capture(49970), session: 'session-b' })
    }
  )
})

describe('relayed panes', () => {
  it('adopts the relay owner verdict over an unproven host record, without probing it', async () => {
    const server = await createServer()
    const envelope = {
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      source: 'claude',
      hookEventName: 'UserPromptSubmit',
      providerSession: { provider: 'claude', id: 'remote' },
      agentPresence: { agent: 'claude', session: 'older' },
      payload: { state: 'working', prompt: 'remote task', agentType: 'claude' }
    }
    server.ingestRemote(envelope, 'ssh-1')
    const relayed = { pid: 4001, platform: 'linux' as const, startTime: 'boot:4001' }
    server.ingestRemote(
      { ...envelope, agentPresence: { agent: 'claude', process: relayed, session: 'remote' } },
      'ssh-1'
    )
    expect(server.presence()).toMatchObject({ process: relayed, session: 'remote' })
    expect(probe).not.toHaveBeenCalled()
    expect(readTable).not.toHaveBeenCalled()
  })
})

describe('acquisition cost', () => {
  it('reads no process table for hooks from a proven owner, at any volume', async () => {
    const server = await createServer()
    runningPane(CLAUDE)
    observe(server, 'waiting')
    await hook(server, 'SessionStart', { session: 'session-a' })
    expect(readTable).toHaveBeenCalledOnce()
    for (const count of [20, 200]) {
      readTable.mockClear()
      probe.mockClear()
      for (let index = 0; index < count; index++) {
        await hook(server, index % 2 ? 'PreToolUse' : 'PostToolUse', { session: 'session-a' })
      }
      expect(readTable).not.toHaveBeenCalled()
      expect(probe).not.toHaveBeenCalled()
    }
  })

  it('reads once per hook while the evidence stays unknown, never on a timer', async () => {
    const server = await createServer()
    table = [SHELL]
    live.add(49969)
    await hook(server, 'UserPromptSubmit', { session: 'older', pid: null, prompt: 'old' })
    for (let index = 0; index < 5; index++) {
      await hook(server, 'PostToolUse', { session: 'older' })
    }
    expect(readTable).toHaveBeenCalledTimes(5)
    runningPane(CLAUDE)
    await hook(server, 'PostToolUse', { session: 'older' })
    readTable.mockClear()
    await hook(server, 'PostToolUse', { session: 'older' })
    expect(readTable).not.toHaveBeenCalled()
  })
})
