import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { RelayDispatcher, RequestContext } from './dispatcher'
// Keep in sync with src/shared/host-session-types.ts — HostSession/HostSessionAgent.
import type {
  HostSession,
  HostSessionAgent,
  HostSessionsResult
} from '../shared/host-session-types'

const execFileAsync = promisify(execFile)

// tmux -F fields are joined with a literal tab; a real path never contains one.
const TAB = '\t'

// Why: cap the probe so a host with a runaway number of panes can't produce an
// unbounded payload or make the git-branch fan-out dominate the response time.
const MAX_SESSIONS = 100

// Why: match the agent by the leaf command in the pane's process subtree. tmux
// only reports pane_current_command (the immediate foreground process), but the
// real agent (claude/codex) is usually a descendant of a shell, so we walk the
// process tree rather than trusting the foreground command alone.
const AGENT_PATTERNS: { agent: Exclude<HostSessionAgent, null>; test: RegExp }[] = [
  { agent: 'claude', test: /(^|\/)claude\b/i },
  { agent: 'codex', test: /(^|\/)codex\b/i }
]

const TMUX_PANE_FORMAT = [
  '#{session_name}',
  '#{pane_current_path}',
  '#{pane_current_command}',
  '#{session_attached}',
  '#{pane_pid}'
].join(TAB)

export type RawPane = Pick<HostSession, 'session' | 'cwd' | 'command' | 'attached' | 'pid'>

export type ProcEntry = { ppid: number; comm: string }

export class HostSessionsHandler {
  constructor(dispatcher: RelayDispatcher) {
    dispatcher.onRequest('host.discoverSessions', (_params, context: RequestContext) =>
      this.discover(context)
    )
  }

  // Why: the relay already runs ON the target host, so we probe tmux/ps/git
  // locally — no SSH round-trip per probe like a client-side prober would need.
  private async discover(context: RequestContext): Promise<HostSessionsResult> {
    const paneOutput = await this.runTmuxListPanes(context.signal)
    if (paneOutput === null) {
      return { sessions: [], tmuxAvailable: false }
    }

    const panes = paneOutput
      .split('\n')
      .map(parseTmuxPaneLine)
      .filter((pane): pane is RawPane => pane !== null)
      .slice(0, MAX_SESSIONS)

    if (panes.length === 0) {
      return { sessions: [], tmuxAvailable: true }
    }

    const procTable = parseProcTable(await this.runPs(context.signal))
    const branchByCwd = await this.resolveBranches(panes, context.signal)

    const sessions: HostSession[] = panes.map((pane) => ({
      ...pane,
      agent: classifyAgentFromProcTable(pane.pid, procTable),
      branch: branchByCwd.get(pane.cwd)
    }))

    return { sessions, tmuxAvailable: true }
  }

  private async runTmuxListPanes(signal?: AbortSignal): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync('tmux', ['list-panes', '-a', '-F', TMUX_PANE_FORMAT], {
        signal
      })
      return stdout
    } catch {
      // tmux missing, or no server running → indistinguishable here and both mean
      // "nothing to observe". Callers surface this as tmuxAvailable: false.
      return null
    }
  }

  private async runPs(signal?: AbortSignal): Promise<string> {
    try {
      const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,comm='], { signal })
      return stdout
    } catch {
      // No ps → every pane stays classified as agent: null rather than failing.
      return ''
    }
  }

  private async resolveBranches(
    panes: RawPane[],
    signal?: AbortSignal
  ): Promise<Map<string, string>> {
    const uniqueCwds = [...new Set(panes.map((pane) => pane.cwd))]
    const branchByCwd = new Map<string, string>()
    await Promise.all(
      uniqueCwds.map(async (cwd) => {
        const branch = await this.gitBranch(cwd, signal)
        if (branch) {
          branchByCwd.set(cwd, branch)
        }
      })
    )
    return branchByCwd
  }

  private async gitBranch(cwd: string, signal?: AbortSignal): Promise<string | undefined> {
    try {
      const { stdout } = await execFileAsync('git', ['-C', cwd, 'branch', '--show-current'], {
        signal
      })
      return stdout.trim() || undefined
    } catch {
      return undefined
    }
  }
}

export function parseTmuxPaneLine(line: string): RawPane | null {
  if (!line) {
    return null
  }
  const fields = line.split(TAB)
  if (fields.length < 5) {
    return null
  }
  const [session, cwd, command, attached, pidRaw] = fields
  if (!session || !cwd) {
    return null
  }
  const pid = Number.parseInt(pidRaw, 10)
  return {
    session,
    cwd,
    command,
    // session_attached is a client count ("0" when detached).
    attached: attached !== '0' && attached !== '',
    pid: Number.isNaN(pid) ? undefined : pid
  }
}

// Why: `ps -axo pid=,ppid=,comm=` emits three space-separated columns with no
// header (the `=` suffixes suppress it); comm may itself contain spaces, so we
// anchor on the two leading numeric columns and keep the remainder as comm.
export function parseProcTable(psStdout: string): Map<number, ProcEntry> {
  const table = new Map<number, ProcEntry>()
  for (const line of psStdout.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)
    if (!match) {
      continue
    }
    table.set(Number.parseInt(match[1], 10), {
      ppid: Number.parseInt(match[2], 10),
      comm: match[3]
    })
  }
  return table
}

export function classifyAgentFromProcTable(
  rootPid: number | undefined,
  table: Map<number, ProcEntry>
): HostSessionAgent {
  if (rootPid == null) {
    return null
  }

  const childrenByPpid = new Map<number, number[]>()
  for (const [pid, entry] of table) {
    const siblings = childrenByPpid.get(entry.ppid) ?? []
    siblings.push(pid)
    childrenByPpid.set(entry.ppid, siblings)
  }

  const queue = [rootPid]
  const seen = new Set<number>()
  while (queue.length > 0) {
    const pid = queue.shift()!
    if (seen.has(pid)) {
      continue
    }
    seen.add(pid)

    const comm = table.get(pid)?.comm ?? ''
    const hit = AGENT_PATTERNS.find((pattern) => pattern.test.test(comm))
    if (hit) {
      return hit.agent
    }

    for (const child of childrenByPpid.get(pid) ?? []) {
      queue.push(child)
    }
  }

  return null
}
