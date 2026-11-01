import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from './server'
import { buildBody, PANE, postHookEvent } from './server.test-fixtures'
import type { AgentProcessIdentity } from '../../shared/agent-process-presence'
import type { probeAgentProcessPresence } from '../../shared/agent-process-presence-probe'
import {
  readHookRootEvidence,
  type HookPaneProcessIo
} from '../../shared/hook-process-root-evidence'
import type { ProcessTableRow } from '../../shared/process-table-snapshot'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))

const live = new Set<number>()
const probe = vi.hoisted(() => vi.fn<typeof probeAgentProcessPresence>())
vi.mock('../../shared/agent-process-presence-probe', () => ({ probeAgentProcessPresence: probe }))

const NOW = Date.UTC(2026, 10, 1, 12)
const TTY = 'ttys004'
type Proc = [pid: number, ppid: number, pgid: number, command: string, stat?: string, tty?: string]
// Recorded macOS shapes: the pane root is login(1); Claude's Bash tool runs commands in a new
// session with no terminal (`Ss`, `??`), so a nested run sits outside the pane's terminal.
const ROOT: Proc = [100, 90, 100, '/usr/bin/login -flpq u /bin/zsh -l', 'Ss']
const SHELL: Proc = [101, 100, 101, '-zsh', 'S']
const CLAUDE: Proc = [49969, 101, 49969, 'claude', 'S+']
const NESTED: Proc[] = [
  [
    49975,
    49969,
    49975,
    "/bin/zsh -c source '/Users/u/.claude/shell-snapshots/s.sh' && eval 'claude -p summarize'",
    'Ss',
    '??'
  ],
  [49980, 49975, 49975, 'claude -p summarize', 'S', '??']
]
const BACKGROUND: Proc = [49990, 101, 49990, 'claude -p "nightly report"', 'S']

let rows: ProcessTableRow[] = []
const io = {
  resolveRoot: vi.fn<HookPaneProcessIo['resolveRoot']>(async () => ({
    pid: 100,
    incarnation: 'inc-1'
  })),
  probe: (identity: AgentProcessIdentity) => probe(identity),
  readProcesses: vi.fn(async (pids: readonly number[]) =>
    rows.filter((row) => pids.includes(row.pid))
  ),
  readTerminal: vi.fn(async (tty: string) => rows.filter((row) => row.tty === tty))
}

const servers: AgentHookServer[] = []
const paths: string[] = []

beforeEach(() => {
  // Only the clock is fixed; the hook server's sockets keep real timers.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop()
  }
  for (const path of paths.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
  live.clear()
  rows = []
  vi.clearAllMocks()
  probe.mockReset()
  vi.useRealTimers()
})

class RootTestServer extends AgentHookServer {
  exits = 0

  override reconcileEndedProcessForPaneKeys(
    ...args: Parameters<AgentHookServer['reconcileEndedProcessForPaneKeys']>
  ): number {
    this.exits++
    return super.reconcileEndedProcessForPaneKeys(...args)
  }

  presence() {
    return this.state.lastStatusByPaneKey.get(PANE)?.agentPresence
  }

  foldedPrompt() {
    return this.state.lastPromptByPaneKey.get(PANE)
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
  server.setHookRootEvidenceReader((request) => readHookRootEvidence(request, io))
  await server.start({ env: 'production', ...(userDataPath ? { userDataPath } : {}) })
  return server
}

/** The pane's processes; `foreground` holds the pane terminal's foreground group. */
function runningPane(foreground: number, ...procs: Proc[]): void {
  rows = [ROOT, SHELL, ...procs].map(([pid, ppid, pgid, command, stat = 'S', tty = TTY]) => ({
    pid,
    ppid,
    pgid,
    tpgid: tty === TTY ? foreground : 0,
    stat,
    tty,
    command
  }))
  for (const [pid] of procs) {
    live.add(pid)
  }
}

const attempts = () => io.resolveRoot.mock.calls.length

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

const codexTurn = (server: AgentHookServer, prompt = 'task') =>
  hook(server, 'UserPromptSubmit', { session: 'cx', pid: null, prompt, source: 'codex' })

describe('a pane without a proven owner', () => {
  it.each<[string, (server: RootTestServer) => Promise<void> | void]>([
    ['no record yet', () => {}],
    ['a trust prompt seen before the first hook', (server) => observe(server, 'waiting')],
    [
      'a forked resume seeded with its source session',
      (server) => {
        server.recordLaunchResumeIdentity({
          paneKey: PANE,
          worktreeId: 'wt-1',
          agentType: 'claude',
          providerSession: { key: 'session_id', id: 'fork-source' },
          launchedAt: NOW - 1
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
    ['another agent whose turn was left working when it exited', (server) => codexTurn(server)],
    [
      'another agent that left its record in the pane',
      async (server) => {
        await codexTurn(server)
        await hook(server, 'Stop', { session: 'cx', pid: null, source: 'codex' })
      }
    ]
  ])('acquires %s from its root agent on an ordinary hook', async (_name, setup) => {
    const server = await createServer()
    runningPane(49969, CLAUDE, ...NESTED)
    await setup(server)
    await hook(server, 'PostToolUse', { session: 'session-a' })
    expect(server.presence()).toMatchObject({
      agent: 'claude',
      process: capture(49969),
      session: 'session-a'
    })
    expect(server.row()).toMatchObject({
      agentType: 'claude',
      providerSession: { id: 'session-a' }
    })
    // Once acquired, the owner's exact process keeps a nested run out of its row.
    await hook(server, 'UserPromptSubmit', { session: 'nested', pid: 49980, prompt: 'nested task' })
    expect(server.row()?.providerSession?.id).toBe('session-a')
    expect(attempts()).toBe(1)
  })

  it('acquires a Claude started through a shell script named claude', async () => {
    const server = await createServer()
    runningPane(
      49960,
      [49960, 101, 49960, 'bash /Users/u/bin/claude', 'S+'],
      [49969, 49960, 49960, 'node /opt/homebrew/bin/claude', 'S+']
    )
    observe(server, 'waiting')
    await hook(server, 'SessionStart', { session: 'session-a' })
    await hook(server, 'UserPromptSubmit', { session: 'session-a', prompt: 'Wrapped task' })
    expect(server.row()).toMatchObject({ state: 'working', prompt: 'Wrapped task' })
    expect(server.presence()).toMatchObject({ process: capture(49969), session: 'session-a' })
  })

  it('shows a spawning shim’s status without naming its process the owner', async () => {
    const server = await createServer()
    runningPane(
      49960,
      [49960, 101, 49960, 'claude', 'S+'],
      [49969, 49960, 49960, 'node /Users/u/.volta/tools/image/claude-code/cli.js', 'S+']
    )
    await hook(server, 'UserPromptSubmit', { session: 'session-a', prompt: 'Shim task' })
    expect(server.row()).toMatchObject({ state: 'working', prompt: 'Shim task' })
    expect(server.presence()).toEqual({ agent: 'claude', session: 'session-a' })
  })

  it.each([['parent'], [undefined]])(
    'keeps a detached nested run out of an unproven owner in session %s, through its exit',
    async (session) => {
      const server = await createServer()
      runningPane(49969, CLAUDE, ...NESTED)
      await hook(server, 'UserPromptSubmit', { session, pid: null, prompt: 'Parent task' })
      await hook(server, 'UserPromptSubmit', {
        session: 'nested',
        pid: 49980,
        prompt: 'nested task'
      })
      await hook(server, 'Stop', { session: 'nested', pid: 49980 })
      await hook(server, 'SessionEnd', {
        session: 'nested',
        pid: 49980,
        reason: 'prompt_input_exit'
      })
      expect(server.row()).toMatchObject({ state: 'working', prompt: 'Parent task' })
      expect(server.presence()?.process).toBeUndefined()
      expect(server.exits).toBe(0)
    }
  )

  it('keeps a nested run that reports first out of the pane, then admits its parent', async () => {
    const server = await createServer()
    runningPane(49969, CLAUDE, ...NESTED)
    await hook(server, 'UserPromptSubmit', { session: 'nested', pid: 49980, prompt: 'nested' })
    expect(server.row()).toBeUndefined()
    await hook(server, 'PostToolUse', { session: 'session-a' })
    expect(server.presence()).toMatchObject({ process: capture(49969), session: 'session-a' })
  })

  it('keeps a background agent from taking a pane whose agent waits at its trust prompt', async () => {
    const server = await createServer()
    runningPane(49969, CLAUDE, BACKGROUND)
    observe(server, 'waiting')
    await hook(server, 'SessionStart', { session: 'nightly', pid: 49990 })
    await hook(server, 'UserPromptSubmit', { session: 'nightly', pid: 49990, prompt: 'Nightly' })
    expect(server.row()?.state).toBe('waiting')
    expect(server.presence()).toBeUndefined()
    await hook(server, 'SessionStart', { session: 'session-a' })
    expect(server.presence()).toMatchObject({ process: capture(49969), session: 'session-a' })
  })

  it('keeps a Claude in another terminal that inherited the pane key out of a Codex pane', async () => {
    const server = await createServer()
    runningPane(
      49969,
      [49969, 101, 49969, 'codex', 'S+'],
      [60000, 1, 60000, '/Applications/Code.app/Contents/MacOS/Code Helper', 'S', '??'],
      [60001, 60000, 60001, 'claude', 'S+', 'ttys009']
    )
    await codexTurn(server, 'Codex task')
    await hook(server, 'UserPromptSubmit', { session: 'foreign', pid: 60001, prompt: 'Foreign' })
    await hook(server, 'Stop', { session: 'cx', pid: null, source: 'codex' })
    expect(server.row()).toMatchObject({ agentType: 'codex', state: 'done', prompt: 'Codex task' })
    expect(server.presence()).toEqual({ agent: 'codex', session: 'cx' })
  })

  it('applies an unreadable acquisition as a hook without a process, then retries next turn', async () => {
    const server = await createServer()
    observe(server, 'waiting')
    await hook(server, 'UserPromptSubmit', { session: 'older', prompt: 'next' })
    expect(server.row()).toMatchObject({ state: 'working', prompt: 'next' })
    expect(server.presence()).toEqual({ agent: 'claude', session: 'older' })
    runningPane(49969, CLAUDE)
    await hook(server, 'UserPromptSubmit', { session: 'older', prompt: 'again' })
    expect(server.presence()).toMatchObject({ process: capture(49969), session: 'older' })
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
        receivedAt: NOW,
        agentProcess: JSON.stringify(capture(49969)),
        payload: { hook_event_name: 'PostToolUse', session_id: 'session-a', tool_name: 'Bash' }
      }
      writeFileSync(join(spoolDir, 'pane-spooled.jsonl'), `\n${JSON.stringify(record)}\n`)
      runningPane(49969, CLAUDE)
      const restarted = await createServer(userDataPath)
      expect(restarted.presence()).toMatchObject({ process: capture(49969), session: 'session-a' })
    }
  )
})

describe('a scoped provider’s session binding', () => {
  it('keeps a Claude run under Hermes out, then lets the pane’s next Claude own it', async () => {
    const server = await createServer()
    runningPane(
      49960,
      [49960, 101, 49960, 'hermes', 'S+'],
      [49975, 49960, 49975, '/bin/bash -c claude -p summarize', 'Ss', '??'],
      [49980, 49975, 49975, 'claude -p summarize', 'S', '??']
    )
    const hermes = { pid: null, source: 'hermes', session: 'hermes-root' }
    await hook(server, 'pre_llm_call', hermes)
    await hook(server, 'UserPromptSubmit', { session: 'nested', pid: 49980, prompt: 'nested' })
    expect(server.presence()).toEqual({ agent: 'hermes' })
    expect(server.row()?.agentType).toBe('hermes')
    // Hermes exits and the user starts Claude in the same pane.
    runningPane(49969, CLAUDE)
    await hook(server, 'SessionStart', { session: 'session-a' })
    expect(server.presence()).toMatchObject({ agent: 'claude', process: capture(49969) })
  })
})

describe('the pane root’s exit', () => {
  it('retires an unproven record of its own agent once, whatever session it names', async () => {
    const server = await createServer()
    runningPane(49969, CLAUDE)
    await hook(server, 'UserPromptSubmit', { session: 'older', pid: null, prompt: 'old' })
    await hook(server, 'SessionEnd', { session: 'session-a', reason: 'prompt_input_exit' })
    expect(server.exits).toBe(1)
    expect(server.presence()).toMatchObject({
      agent: 'claude',
      process: capture(49969),
      session: 'session-a',
      ended: true
    })
    // A replayed or late exit from the retired process changes nothing.
    await hook(server, 'SessionEnd', { session: 'session-a', reason: 'prompt_input_exit' })
    await hook(server, 'Stop', { session: 'session-a' })
    expect(server.exits).toBe(1)
  })

  it('leaves another agent’s record to that agent', async () => {
    const server = await createServer()
    runningPane(49969, CLAUDE)
    await codexTurn(server)
    await hook(server, 'SessionEnd', { session: 'session-a', reason: 'prompt_input_exit' })
    expect(server.exits).toBe(0)
    expect(server.presence()).toEqual({ agent: 'codex', session: 'cx' })
  })
})

describe('terminal reports and Orca restatements', () => {
  it('lets a terminal-first Codex name its own session from its first hook', async () => {
    const server = await createServer()
    observe(server, 'working', 'codex')
    expect(server.presence()).toBeUndefined()
    await codexTurn(server)
    expect(server.presence()).toEqual({ agent: 'codex', session: 'cx' })
  })

  it('keeps a resumed Codex conversation over a Claude run inside it', async () => {
    const server = await createServer()
    runningPane(49969, [49969, 101, 49969, 'codex resume cx', 'S+'], ...NESTED)
    server.recordLaunchResumeIdentity({
      paneKey: PANE,
      worktreeId: 'wt-1',
      agentType: 'codex',
      providerSession: { key: 'session_id', id: 'cx' },
      launchedAt: NOW - 1
    })
    observe(server, 'working', 'codex')
    await codexTurn(server, 'Codex task')
    await hook(server, 'Stop', { session: 'cx', pid: null, source: 'codex' })
    await hook(server, 'UserPromptSubmit', {
      session: 'nested',
      pid: 49980,
      prompt: 'Background job'
    })
    await codexTurn(server, 'Next task')
    expect(server.row()).toMatchObject({ agentType: 'codex', prompt: 'Next task' })
    expect(server.presence()).toEqual({ agent: 'codex', session: 'cx' })
  })

  it('keeps a suspended owner through a terminal report', async () => {
    const server = await createServer()
    runningPane(49969, CLAUDE)
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
      runningPane(49969, CLAUDE)
      await hook(server, 'SessionStart', { session: 'session-a' })
      await hook(server, 'SessionEnd', { session: 'session-a', reason: 'prompt_input_exit' })
      observe(server, state, 'claude', origin)
      expect(server.row()?.state).toBe(state)
      // Late and replayed hooks from the exited process change nothing.
      await hook(server, 'UserPromptSubmit', { session: 'session-a', prompt: 'stale prompt' })
      // Refused before provider folds, which the successor would otherwise inherit.
      expect(server.foldedPrompt()).toBeUndefined()
      await hook(server, 'Stop', { session: 'session-a' })
      await hook(server, 'SessionStart', { session: 'session-a' })
      await hook(server, 'SessionEnd', { session: 'session-a', reason: 'prompt_input_exit' })
      expect(server.row()?.state).toBe(state)
      expect(server.hasVerifiableAgentProcess(PANE)).toBe(false)
      // The user resumes the same conversation in a new process.
      runningPane(49970, [49970, 101, 49970, 'claude', 'S+'])
      await hook(server, 'PostToolUse', { session: 'session-a', pid: 49970 })
      expect(server.presence()).toMatchObject({ process: capture(49970), session: 'session-a' })
    }
  )
})

describe('relayed panes', () => {
  const envelope = {
    paneKey: PANE,
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    source: 'claude',
    hookEventName: 'UserPromptSubmit',
    providerSession: { provider: 'claude', id: 'parent' },
    agentPresence: { agent: 'claude', session: 'parent' },
    payload: { state: 'working', prompt: 'Parent task', agentType: 'claude' }
  }
  const child = { pid: 4006, platform: 'linux' as const, startTime: 'boot:4006' }

  it('adopts a pane-root-proving relay’s owner over an unproven host record, without probing it', async () => {
    const server = await createServer()
    server.ingestRemote(envelope, 'wsl:Ubuntu')
    server.noteRelayProvesPaneRoots('wsl:Ubuntu')
    server.ingestRemote(
      { ...envelope, agentPresence: { agent: 'claude', process: child, session: 'parent' } },
      'wsl:Ubuntu'
    )
    expect(server.presence()).toMatchObject({ process: child, session: 'parent' })
    expect(probe).not.toHaveBeenCalled()
    expect(attempts()).toBe(0)
  })

  it('keeps an older relay’s replayed first prover from owning the pane or ending it', async () => {
    const server = await createServer()
    server.ingestRemote(envelope, 'wsl:Ubuntu')
    server.noteRelayProvesPaneRoots('wsl:Ubuntu')
    // The relay restarts as a build that never asks for pane roots, then replays a nested run.
    server.beginRemoteRelaySession('wsl:Ubuntu')
    const nested = { agent: 'claude', process: child, session: 'nested', sessionOwner: true }
    server.ingestRemote(
      {
        ...envelope,
        isReplay: true,
        providerSession: { provider: 'claude', id: 'nested' },
        agentPresence: nested,
        payload: { ...envelope.payload, prompt: 'Nested task' }
      },
      'wsl:Ubuntu'
    )
    server.ingestRemote(
      {
        ...envelope,
        hookEventName: 'SessionEnd',
        providerSession: { provider: 'claude', id: 'nested' },
        agentPresence: { ...nested, ended: true }
      },
      'wsl:Ubuntu'
    )
    expect(server.presence()).toEqual({ agent: 'claude', session: 'parent' })
    expect(server.row()).toMatchObject({ state: 'working' })
    expect(server.exits).toBe(0)
  })
})

describe('acquisition cost', () => {
  it('reads nothing for hooks from a proven owner, at any volume', async () => {
    const server = await createServer()
    runningPane(49969, CLAUDE)
    observe(server, 'waiting')
    await hook(server, 'SessionStart', { session: 'session-a' })
    expect(attempts()).toBe(1)
    for (const count of [20, 200]) {
      vi.clearAllMocks()
      for (let index = 0; index < count; index++) {
        await hook(server, index % 2 ? 'PreToolUse' : 'PostToolUse', { session: 'session-a' })
      }
      expect(attempts()).toBe(0)
      expect(io.readProcesses).not.toHaveBeenCalled()
      expect(probe).not.toHaveBeenCalled()
    }
  })

  it.each([[5], [50]])(
    'retries unproven evidence once per turn, not per tool hook (%i tool hooks a turn)',
    async (toolHooks) => {
      const server = await createServer()
      // The sender is live but its lineage is unreadable, so every attempt completes unknown.
      runningPane(101)
      live.add(49969)
      const turns = 3
      await hook(server, 'PostToolUse', { session: 'older' })
      for (let turn = 0; turn < turns; turn++) {
        await hook(server, 'UserPromptSubmit', { session: 'older', prompt: `turn ${turn}` })
        for (let index = 0; index < toolHooks; index++) {
          await hook(server, index % 2 ? 'PreToolUse' : 'PostToolUse', { session: 'older' })
        }
      }
      expect(attempts()).toBe(turns + 1)
      expect(server.row()).toMatchObject({ state: 'working', prompt: 'turn 2' })
    }
  )
})
