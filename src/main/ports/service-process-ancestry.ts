import { runPortScanCommand } from './port-scan-command-client'

// Why (#11161): libuv performs process creation inline on the calling thread, so
// this probe runs on the scan worker instead of freezing CrBrowserMain on hosts
// where an endpoint-security hook stalls every spawn. The worker owns the
// command budget, so callers pass no timeout.
type ProbeCommandRunner = (command: string, args: string[]) => Promise<{ stdout: string }>

const MAX_ANCESTOR_DEPTH = 16
/** An agent's command line carries its entire prompt; nothing useful is that long. */
const MAX_LAUNCH_COMMAND_LENGTH = 120

export type ProcessAncestryRow = {
  pid: number
  ppid: number
  command: string
}

export type ProcessAncestryTable = Map<number, ProcessAncestryRow>

/**
 * Commands that end a launch chain. Walking past one would report the user's
 * shell (or Orca itself) as the thing that opened the port.
 */
const SHELL_COMMANDS = new Set([
  'sh',
  'bash',
  'zsh',
  'fish',
  'dash',
  'ksh',
  'csh',
  'tcsh',
  'login',
  'tmux',
  'screen',
  'sshd',
  'cmd',
  'powershell',
  'pwsh',
  'conhost',
  'wsl',
  'init',
  'systemd',
  'launchd'
])

/** Executable suffixes Windows appends; the same tool is `claude` and `claude.exe`. */
const WINDOWS_EXECUTABLE_SUFFIXES = ['.exe', '.cmd', '.bat', '.com', '.ps1']

/**
 * Coding agents we can name from their executable. Deliberately a closed list:
 * an unrecognized parent yields null rather than a guess, because "started by"
 * is exactly the field a wrong answer would make harmful.
 */
const AGENT_COMMANDS = new Map<string, string>([
  ['claude', 'Claude Code'],
  ['codex', 'Codex'],
  ['cursor-agent', 'Cursor'],
  ['aider', 'Aider'],
  ['gemini', 'Gemini CLI'],
  ['opencode', 'OpenCode'],
  ['goose', 'Goose'],
  ['amp', 'Amp']
])

export type ServiceLaunchOrigin = {
  /** Topmost non-shell ancestor, e.g. `pnpm dev` rather than `next-server`. */
  launchCommand: string | null
  /** Display name of the coding agent that owns the launching shell, when recognized. */
  launchedByAgent: string | null
  /** Every ancestor pid walked, so a caller can match them against live PTYs. */
  ancestorPids: number[]
}

export function parseProcessAncestryOutput(stdout: string): ProcessAncestryRow[] {
  const rows: ProcessAncestryRow[] = []
  for (const line of stdout.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)
    if (!match) {
      continue
    }
    const pid = Number.parseInt(match[1], 10)
    const ppid = Number.parseInt(match[2], 10)
    const command = match[3].trim()
    if (!Number.isFinite(pid) || !Number.isFinite(ppid) || !command) {
      continue
    }
    rows.push({ pid, ppid, command })
  }
  return rows
}

export function buildProcessAncestryTable(
  rows: readonly ProcessAncestryRow[]
): ProcessAncestryTable {
  const table: ProcessAncestryTable = new Map()
  for (const row of rows) {
    table.set(row.pid, row)
  }
  return table
}

/** Basename of a path token, preserving case for display. */
export function basename(token: string): string {
  const separator = Math.max(token.lastIndexOf('/'), token.lastIndexOf('\\'))
  return separator === -1 ? token : token.slice(separator + 1)
}

/** Lowercased basename of the executable, for matching against the sets above. */
export function executableName(command: string): string {
  const firstToken = command.trim().split(/\s+/)[0] ?? ''
  return basename(firstToken).toLowerCase()
}

/**
 * Key used to look a command up in the sets above.
 *
 * Windows reports `claude.exe` where POSIX reports `claude`. Keying on the raw
 * basename made every agent lookup miss on Windows, so the badge and the
 * "stop and tell" action silently never appeared there.
 */
export function commandLookupKey(command: string): string {
  const name = executableName(command)
  const suffix = WINDOWS_EXECUTABLE_SUFFIXES.find((candidate) => name.endsWith(candidate))
  return suffix ? name.slice(0, -suffix.length) : name
}

function isShellCommand(command: string): boolean {
  return SHELL_COMMANDS.has(commandLookupKey(command))
}

/**
 * `node /path/to/.bin/pnpm dev` reads as `pnpm dev`. The interpreter and the
 * absolute script path are noise: the user recognizes the tool and its task.
 */
export function condenseLaunchCommand(command: string): string {
  const tokens = command.trim().split(/\s+/)
  if (tokens.length === 0) {
    return command.trim()
  }
  const runner = commandLookupKey(tokens[0])
  const isInterpreter = runner === 'node' || runner === 'bun'
  const condensed =
    !isInterpreter || tokens.length < 2
      ? tokens.map(shortenPathToken).join(' ')
      : [basename(tokens[1]), ...tokens.slice(2).map(shortenPathToken)].filter(Boolean).join(' ')
  return truncateLaunchCommand(condensed)
}

/**
 * Bound the displayed command. A process can hold a command line of arbitrary
 * length, and one long row would blow out the panel's layout.
 */
function truncateLaunchCommand(command: string): string {
  if (command.length <= MAX_LAUNCH_COMMAND_LENGTH) {
    return command
  }
  return `${command.slice(0, MAX_LAUNCH_COMMAND_LENGTH - 1).trimEnd()}…`
}

function shortenPathToken(token: string): string {
  // Keep flags and short values verbatim; only collapse long absolute paths.
  // Case is preserved: this string is shown to the user, not matched on.
  const looksLikePath = token.includes('/') || token.includes('\\')
  if (token.startsWith('-') || !looksLikePath || token.length < 24) {
    return token
  }
  return basename(token) || token
}

/**
 * Walk from the listening process up to the shell that launched it.
 *
 * Returns the topmost non-shell ancestor as the launch command, plus the
 * recognized agent owning the shell. Both fields are null when the chain
 * cannot be followed — the caller renders an em dash rather than a guess.
 */
export function resolveServiceLaunchOrigin(
  pid: number,
  table: ProcessAncestryTable
): ServiceLaunchOrigin {
  const start = table.get(pid)
  if (!start) {
    return { launchCommand: null, launchedByAgent: null, ancestorPids: [] }
  }

  const ancestorPids: number[] = []
  const visited = new Set<number>([pid])
  let topmostNonShell = start
  let current = start

  for (let depth = 0; depth < MAX_ANCESTOR_DEPTH; depth++) {
    const parent = table.get(current.ppid)
    // Why the visited guard: a pid table read while processes exit can contain
    // a reparented row whose ppid points back into the chain, and an unguarded
    // walk would spin until the depth cap on every scan.
    if (!parent || visited.has(parent.pid) || parent.pid === parent.ppid) {
      break
    }
    visited.add(parent.pid)
    ancestorPids.push(parent.pid)

    // Why an agent is a boundary as well as a shell: an agent may spawn a
    // service with no shell in between, and its own command line carries the
    // entire prompt. Climbing into it reports thousands of characters of
    // unrelated text as the launch command.
    const parentAgent = AGENT_COMMANDS.get(commandLookupKey(parent.command))
    if (parentAgent) {
      return {
        launchCommand: condenseLaunchCommand(topmostNonShell.command),
        launchedByAgent: parentAgent,
        ancestorPids
      }
    }

    if (isShellCommand(parent.command)) {
      return {
        launchCommand: condenseLaunchCommand(topmostNonShell.command),
        launchedByAgent: findAgentAbove(parent, table, visited, ancestorPids),
        ancestorPids
      }
    }

    topmostNonShell = parent
    current = parent
  }

  return {
    launchCommand: condenseLaunchCommand(topmostNonShell.command),
    launchedByAgent: null,
    ancestorPids
  }
}

function findAgentAbove(
  shell: ProcessAncestryRow,
  table: ProcessAncestryTable,
  visited: Set<number>,
  ancestorPids: number[]
): string | null {
  let current = shell
  for (let depth = 0; depth < MAX_ANCESTOR_DEPTH; depth++) {
    const parent = table.get(current.ppid)
    if (!parent || visited.has(parent.pid) || parent.pid === parent.ppid) {
      return null
    }
    visited.add(parent.pid)
    ancestorPids.push(parent.pid)
    const agent = AGENT_COMMANDS.get(commandLookupKey(parent.command))
    if (agent) {
      return agent
    }
    current = parent
  }
  return null
}

/**
 * Snapshot the whole process table in one call. Per-pid lookups would mean one
 * child process per listening port, which is the cost this scan cannot pay.
 * Never throws: ancestry is enrichment, and its absence only costs a column.
 */
export async function readProcessAncestryTable(
  runCommand: ProbeCommandRunner = runPortScanCommand
): Promise<ProcessAncestryTable> {
  try {
    if (process.platform === 'win32') {
      return await readWindowsAncestryTable(runCommand)
    }
    const { stdout } = await runCommand('ps', ['-axo', 'pid=,ppid=,command='])
    return buildProcessAncestryTable(parseProcessAncestryOutput(stdout))
  } catch {
    return new Map()
  }
}

async function readWindowsAncestryTable(
  runCommand: ProbeCommandRunner
): Promise<ProcessAncestryTable> {
  const { stdout } = await runCommand('powershell.exe', [
    '-NoProfile',
    '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine,Name | ConvertTo-Json -Compress'
  ])
  return buildProcessAncestryTable(parseWindowsAncestryJson(stdout))
}

export function parseWindowsAncestryJson(stdout: string): ProcessAncestryRow[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return []
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed]
  const result: ProcessAncestryRow[] = []
  for (const entry of rows) {
    if (!entry || typeof entry !== 'object') {
      continue
    }
    const row = entry as {
      ProcessId?: unknown
      ParentProcessId?: unknown
      CommandLine?: unknown
      Name?: unknown
    }
    const pid = Number(row.ProcessId)
    const ppid = Number(row.ParentProcessId)
    // CommandLine is null for processes the session cannot open; the image
    // name still identifies a shell boundary, which is what the walk needs.
    const command =
      typeof row.CommandLine === 'string' && row.CommandLine.trim()
        ? row.CommandLine.trim()
        : typeof row.Name === 'string'
          ? row.Name.trim()
          : ''
    if (!Number.isFinite(pid) || !Number.isFinite(ppid) || !command) {
      continue
    }
    result.push({ pid, ppid, command })
  }
  return result
}
