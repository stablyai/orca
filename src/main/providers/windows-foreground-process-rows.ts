import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)
const WINDOWS_PROCESS_QUERY_TIMEOUT_MS = 3_000

export type WindowsProcessRow = {
  pid: number
  ppid: number
  name: string
  command: string
  executablePath: string
}

export type WindowsProcessCandidate = WindowsProcessRow & { depth: number }

export async function queryWindowsProcessDescendants(
  rootPid: number
): Promise<WindowsProcessCandidate[] | null> {
  const stdout =
    (await queryWindowsProcessesWithPowerShell()) ?? (await queryWindowsProcessesWithWmic())
  return stdout
    ? collectDescendants(parseWindowsProcessRows(stdout), rootPid).sort((a, b) => b.depth - a.depth)
    : null
}

function parseWindowsProcessRows(stdout: string): WindowsProcessRow[] {
  const rows: WindowsProcessRow[] = []
  let command = ''
  let executablePath = ''
  let name = ''
  let pid = Number.NaN
  let ppid = Number.NaN

  const flush = (): void => {
    if (Number.isFinite(pid) && Number.isFinite(ppid)) {
      rows.push({ pid, ppid, name, command: command || name, executablePath })
    }
    command = ''
    executablePath = ''
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
    } else if (key === 'ExecutablePath') {
      executablePath = value
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

async function queryWindowsProcessesWithPowerShell(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance -ClassName Win32_Process -Property CommandLine,ExecutablePath,Name,ParentProcessId,ProcessId | ForEach-Object { "CommandLine=$($_.CommandLine)"; "ExecutablePath=$($_.ExecutablePath)"; "Name=$($_.Name)"; "ParentProcessId=$($_.ParentProcessId)"; "ProcessId=$($_.ProcessId)"; "" }'
      ],
      {
        encoding: 'utf8',
        timeout: WINDOWS_PROCESS_QUERY_TIMEOUT_MS,
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
      [
        'process',
        'get',
        'CommandLine,ExecutablePath,Name,ParentProcessId,ProcessId',
        '/format:value'
      ],
      {
        encoding: 'utf8',
        timeout: WINDOWS_PROCESS_QUERY_TIMEOUT_MS,
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
