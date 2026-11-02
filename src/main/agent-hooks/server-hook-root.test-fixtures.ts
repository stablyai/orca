import { rmSync } from 'node:fs'
import { afterEach, beforeEach, expect, vi } from 'vitest'
import { AgentHookServer } from './server'
import { buildBody, PANE, postHookEvent } from './server.test-fixtures'
import type { AgentProcessIdentity } from '../../shared/agent-process-presence'
import { probeAgentProcessPresence } from '../../shared/agent-process-presence-probe'
import {
  readHookRootEvidence,
  type HookPaneProcessIo,
  type HookPaneRoot
} from '../../shared/hook-process-root-evidence'
import type { ProcessTableRow } from '../../shared/process-table-snapshot'

// Shared harness for the hook server's pane-root acquisition tests. Each test file mocks
// '../telemetry/client', '../telemetry/cohort-classifier' and the process probe module.
export const live = new Set<number>()
// Each test file mocks the probe module (vi.mock is per file); this is that mock.
export const probe = vi.mocked(probeAgentProcessPresence)

export const NOW = Date.UTC(2026, 10, 1, 12)
const TTY = 'ttys004'
export type Proc = [
  pid: number,
  ppid: number,
  pgid: number,
  command: string,
  stat?: string,
  tty?: string
]
// Recorded macOS shapes: the pane root is login(1); Claude's Bash tool runs commands in a new
// session with no terminal (`Ss`, `??`), so a nested run sits outside the pane's terminal.
export const ROOT: Proc = [100, 90, 100, '/usr/bin/login -flpq u /bin/zsh -l', 'Ss']
export const SHELL: Proc = [101, 100, 101, '-zsh', 'S']
export const CLAUDE: Proc = [49969, 101, 49969, 'claude', 'S+']
export const NESTED: Proc[] = [
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
export const BACKGROUND: Proc = [49990, 101, 49990, 'claude -p "nightly report"', 'S']

let rows: ProcessTableRow[] = []
export const io = {
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
export const paths: string[] = []
// Evidence reads that have completed, so a test can await a late answer instead of sleeping.
let answered = 0

/** Registers the fixed clock and per-test cleanup in the calling test file. */
export function registerRootTestHarness(): void {
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
    answered = 0
    vi.clearAllMocks()
    probe.mockReset()
    vi.useRealTimers()
  })
}

export class RootTestServer extends AgentHookServer {
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
export function capture(pid: number): AgentProcessIdentity {
  return { pid, platform: 'darwin', startTime: startOf(pid) }
}

export async function createServer(userDataPath?: string): Promise<RootTestServer> {
  probe.mockImplementation(async (identity) =>
    identity && live.has(identity.pid) ? 'live' : 'unverifiable'
  )
  const server = new RootTestServer()
  servers.push(server)
  server.setHookRootEvidenceReader((request) =>
    readHookRootEvidence(request, io).finally(() => {
      answered++
    })
  )
  await server.start({ env: 'production', ...(userDataPath ? { userDataPath } : {}) })
  return server
}

/** The pane's processes; `foreground` holds the pane terminal's foreground group. */
export function runningPane(foreground: number, ...procs: Proc[]): void {
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

export const attempts = () => io.resolveRoot.mock.calls.length

export async function hook(
  server: AgentHookServer,
  event: string,
  options: {
    session?: string
    pid?: number | null
    prompt?: string
    reason?: string
    source?: string
    tmuxPane?: string
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
      {
        ...(pid === null ? {} : { agentProcess: JSON.stringify(capture(pid)) }),
        ...(options.tmuxPane ? { tmuxPane: options.tmuxPane } : {})
      }
    ),
    `/hook/${options.source ?? 'claude'}`
  )
  expect(response.status).toBe(204)
}

export function observe(
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

export const codexTurn = (server: AgentHookServer, prompt = 'task') =>
  hook(server, 'UserPromptSubmit', { session: 'cx', pid: null, prompt, source: 'codex' })

/** The PTY owner names the pane root only once released, as on a slow or loaded host. */
export function slowRoot(): () => void {
  let release = (): void => {}
  const named = new Promise<HookPaneRoot>((resolve) => {
    release = () => resolve({ pid: 100, incarnation: 'inc-1' })
  })
  io.resolveRoot.mockImplementationOnce(() => named)
  return release
}

/** Let a released late answer reach the host. */
export async function settled(): Promise<void> {
  await vi.waitFor(() => expect(answered).toBe(1))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

// A binary shim that spawns the agent in its own job: process metadata cannot tell it from nesting.
export const SHIM: Proc[] = [
  [49960, 101, 49960, 'claude', 'S+'],
  [49969, 49960, 49960, 'node /Users/u/.volta/tools/image/claude-code/cli.js', 'S+']
]
// A tmux server started from the pane and its inner pane, on its own terminal.
export const TMUX: Proc[] = [
  [4041, 1, 4041, 'tmux', 'Ss', '??'],
  [4042, 4041, 4042, '-zsh', 'Ss', 'ttys011'],
  [4043, 4042, 4043, 'claude', 'S+', 'ttys011']
]
export const TMUX_HINT = '%1 /private/tmp/tmux-501/default'
