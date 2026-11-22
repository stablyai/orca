import { rmSync } from 'node:fs'
import { afterEach, beforeEach, expect, vi } from 'vitest'
import { AgentHookServer } from '../../agent-hook-server'
import { buildBody, PANE, postHookEvent } from '../server.test-fixtures'
import type { AgentProcessIdentity } from '../../../../../shared/agent-status/process/agent-process-presence'
import { probeAgentProcessPresence } from '../../../../../shared/agent-status/process/agent-process-presence-probe'
import {
  readHookRootEvidence,
  type HookPaneProcessIo
} from '../../../../../shared/agent-hook-listener/presence/hook-process-root-evidence'
import type { ProcessTableRow } from '../../../../../shared/process-observation/tables/process-table-snapshot'

// Harness for legacy tmux hook tests; the test file mocks telemetry and the process probe module.
const live = new Set<number>()
// Each test file mocks the probe module (vi.mock is per file); this is that mock.
const probe = vi.mocked(probeAgentProcessPresence)

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
// Recorded macOS shape: the pane root is login(1).
const ROOT: Proc = [100, 90, 100, '/usr/bin/login -flpq u /bin/zsh -l', 'Ss']
const SHELL: Proc = [101, 100, 101, '-zsh', 'S']

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
const paths: string[] = []

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
    vi.clearAllMocks()
    probe.mockReset()
    vi.useRealTimers()
  })
}

export class RootTestServer extends AgentHookServer {
  row(paneKey = PANE) {
    return this.getStatusSnapshot().find(
      (entry) => entry.paneKey === paneKey && !entry.providerSessionOnly
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

/** A server whose startup (spool replay included) the caller drives; `reader: false` installs none. */
function launchServer(
  userDataPath?: string,
  options: { reader?: boolean; start?: (server: RootTestServer) => Promise<void> } = {}
): { server: RootTestServer; started: Promise<void> } {
  probe.mockImplementation(async (identity) =>
    identity && live.has(identity.pid) ? 'live' : 'unverifiable'
  )
  const server = new RootTestServer()
  servers.push(server)
  if (options.reader !== false) {
    server.setHookRootEvidenceReader((request) => readHookRootEvidence(request, io))
  }
  const start =
    options.start ??
    ((target) => target.start({ env: 'production', ...(userDataPath ? { userDataPath } : {}) }))
  return { server, started: start(server) }
}

export async function createServer(userDataPath?: string): Promise<RootTestServer> {
  const { server, started } = launchServer(userDataPath)
  await started
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

export const codexTurn = (server: AgentHookServer, prompt = 'task') =>
  hook(server, 'UserPromptSubmit', { session: 'cx', pid: null, prompt, source: 'codex' })

// A tmux server started from the pane and its inner pane, on its own terminal.
export const TMUX: Proc[] = [
  [4041, 1, 4041, 'tmux', 'Ss', '??'],
  [4042, 4041, 4042, '-zsh', 'Ss', 'ttys011'],
  [4043, 4042, 4043, 'claude', 'S+', 'ttys011']
]
export const TMUX_HINT = '%1 /private/tmp/tmux-501/default'
