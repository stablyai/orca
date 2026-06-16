import { execFile } from 'child_process'
import { promisify } from 'util'
import {
  isAgentForegroundWrapperProcess,
  isExpectedAgentProcess,
  recognizeAgentProcessFromCommandLine
} from '../../shared/agent-process-recognition'

const execFileAsync = promisify(execFile)

type ProcessRow = {
  pid: number
  ppid: number
  stat: string
  command: string
}

type WindowsProcessRow = {
  pid: number
  ppid: number
  name: string
  command: string
}

function parsePsRows(stdout: string): ProcessRow[] {
  const rows: ProcessRow[] = []
  for (const line of stdout.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/)
    if (!match) {
      continue
    }
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      stat: match[3],
      command: match[4]
    })
  }
  return rows
}

function parseWindowsProcessRows(stdout: string): WindowsProcessRow[] {
  const rows: WindowsProcessRow[] = []
  let command = ''
  let name = ''
  let pid = Number.NaN
  let ppid = Number.NaN

  const flush = (): void => {
    if (Number.isFinite(pid) && Number.isFinite(ppid)) {
      rows.push({ pid, ppid, name, command: command || name })
    }
    command = ''
    name = ''
    pid = Number.NaN
    ppid = Number.NaN
  }

  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) {
      flush()
      continue
    }
    const eq = line.indexOf('=')
    if (eq < 0) {
      continue
    }
    const key = line.slice(0, eq)
    const value = line.slice(eq + 1)
    if (key === 'CommandLine') {
      command = value
    } else if (key === 'Name') {
      name = value
    } else if (key === 'ParentProcessId') {
      ppid = Number.parseInt(value, 10)
    } else if (key === 'ProcessId') {
      pid = Number.parseInt(value, 10)
    }
  }
  flush()
  return rows
}

function collectDescendants<Row extends { pid: number; ppid: number }>(
  rows: Row[],
  rootPid: number
): (Row & { depth: number })[] {
  const childrenByParent = new Map<number, Row[]>()
  for (const row of rows) {
    const children = childrenByParent.get(row.ppid) ?? []
    children.push(row)
    childrenByParent.set(row.ppid, children)
  }

  const descendants: (Row & { depth: number })[] = []
  const stack = (childrenByParent.get(rootPid) ?? []).map((row) => ({ row, depth: 1 }))
  while (stack.length > 0) {
    const { row, depth } = stack.pop()!
    descendants.push({ ...row, depth })
    for (const child of childrenByParent.get(row.pid) ?? []) {
      stack.push({ row: child, depth: depth + 1 })
    }
  }
  return descendants
}

function candidateScore(row: ProcessRow & { depth: number }): number {
  // Why: foreground descendants carry `+` in `ps stat` on Unix PTYs. Prefer
  // them, then prefer leaf/deeper wrappers so `node /path/bin/codex` beats the
  // parent shell but still lets the native child confirm the same identity.
  return (row.stat.includes('+') ? 10_000 : 0) + row.depth
}

export async function resolveAgentForegroundProcess(
  shellPid: number | null | undefined,
  fallbackProcess: string | null
): Promise<string | null> {
  if (!shellPid) {
    return fallbackProcess
  }

  if (process.platform === 'win32') {
    if (!fallbackProcess || !isAgentForegroundWrapperProcess(fallbackProcess)) {
      return fallbackProcess
    }
    return (
      (await resolveAgentForegroundProcessFromWindows(shellPid, fallbackProcess)) ?? fallbackProcess
    )
  }

  try {
    const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,stat=,command='], {
      encoding: 'utf8',
      timeout: 3000
    })
    return resolveAgentForegroundProcessFromPs(stdout, shellPid) ?? fallbackProcess
  } catch {
    // Fall through to node-pty's process name. Foreground process inspection is
    // best-effort because terminal identity should never break PTY operation.
  }

  return fallbackProcess
}

async function resolveAgentForegroundProcessFromWindows(
  shellPid: number,
  fallbackProcess: string
): Promise<string | null> {
  const stdout =
    (await queryWindowsProcessesWithPowerShell()) ?? (await queryWindowsProcessesWithWmic())
  return stdout
    ? resolveAgentForegroundProcessFromWindowsRows(stdout, shellPid, fallbackProcess)
    : null
}

async function queryWindowsProcessesWithPowerShell(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_Process | ForEach-Object { "CommandLine=$($_.CommandLine)"; "Name=$($_.Name)"; "ParentProcessId=$($_.ParentProcessId)"; "ProcessId=$($_.ProcessId)"; "" }'
      ],
      {
        encoding: 'utf8',
        timeout: 3000,
        maxBuffer: 8 * 1024 * 1024
      }
    )
    return stdout
  } catch {
    return null
  }
}

async function queryWindowsProcessesWithWmic(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'wmic',
      ['process', 'get', 'CommandLine,Name,ParentProcessId,ProcessId', '/format:value'],
      {
        encoding: 'utf8',
        timeout: 3000,
        maxBuffer: 8 * 1024 * 1024
      }
    )
    return stdout
  } catch {
    // Best-effort: Windows process enumeration may be disabled, so callers
    // still fall back to node-pty's process name when both probes fail.
    return null
  }
}

function resolveAgentForegroundProcessFromWindowsRows(
  stdout: string,
  shellPid: number,
  fallbackProcess: string
): string | null {
  const candidates = collectDescendants(parseWindowsProcessRows(stdout), shellPid).sort(
    (a, b) => b.depth - a.depth
  )
  const wrapperCandidates = candidates.filter((candidate) =>
    windowsCandidateMatchesFallbackWrapper(candidate, fallbackProcess)
  )
  if (wrapperCandidates.length !== 1) {
    return null
  }
  const [candidate] = wrapperCandidates
  const recognized =
    recognizeAgentProcessFromCommandLine(candidate.command) ??
    recognizeAgentProcessFromCommandLine(candidate.name)
  if (recognized) {
    return recognized.processName
  }
  return null
}

function windowsCandidateMatchesFallbackWrapper(
  candidate: WindowsProcessRow,
  fallbackProcess: string
): boolean {
  const commandToken = candidate.command.trim().split(/\s+/, 1)[0] ?? ''
  return (
    isExpectedAgentProcess(candidate.name, fallbackProcess) ||
    isExpectedAgentProcess(commandToken, fallbackProcess)
  )
}

function resolveAgentForegroundProcessFromPs(stdout: string, shellPid: number): string | null {
  const rows = parsePsRows(stdout)
  const shellRow = rows.find((row) => row.pid === shellPid)
  const candidates = collectDescendants(rows, shellPid).sort(
    (a, b) => candidateScore(b) - candidateScore(a)
  )
  // Why: `+` in `ps stat` marks the process holding the terminal foreground.
  // The root shell can hold it after Ctrl-Z, so use the whole PTY tree as the
  // foreground gate; otherwise a stopped agent child still masquerades as live.
  const foregroundIsKnown =
    shellRow?.stat.includes('+') === true ||
    candidates.some((candidate) => candidate.stat.includes('+'))
  for (const candidate of candidates) {
    if (foregroundIsKnown && !candidate.stat.includes('+')) {
      continue
    }
    const recognized = recognizeAgentProcessFromCommandLine(candidate.command)
    if (recognized) {
      return recognized.processName
    }
  }
  return null
}
