import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const WINDOWS_PROCESS_TIMEOUT_MS = 5_000
const WINDOWS_PROCESS_MAX_BUFFER = 10 * 1024 * 1024

export type WindowsProcessWorkingSetRow = {
  pid: number
  ppid: number
  /** CPU% is unavailable from this bounded single-shot query. */
  cpu: number
  /** Resident memory in bytes. */
  memory: number
}

type CimProcessRow = {
  ProcessId?: unknown
  ParentProcessId?: unknown
  WorkingSetSize?: unknown
}

export async function enumerateWindowsProcessWorkingSet(): Promise<WindowsProcessWorkingSetRow[]> {
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize | ConvertTo-Json -Compress'
      ],
      { maxBuffer: WINDOWS_PROCESS_MAX_BUFFER, timeout: WINDOWS_PROCESS_TIMEOUT_MS }
    )
    return parseWindowsProcessWorkingSetJson(stdout)
  } catch (cimError) {
    try {
      const { stdout } = await execFileAsync(
        'wmic',
        ['process', 'get', 'ProcessId,ParentProcessId,WorkingSetSize', '/format:value'],
        { maxBuffer: WINDOWS_PROCESS_MAX_BUFFER, timeout: WINDOWS_PROCESS_TIMEOUT_MS }
      )
      return parseWmicOutput(stdout)
    } catch (wmicError) {
      console.warn('[memory] Windows process enumeration failed', {
        cim: cimError,
        wmic: wmicError
      })
      return []
    }
  }
}

export function parseWindowsProcessWorkingSetJson(stdout: string): WindowsProcessWorkingSetRow[] {
  const trimmed = stdout.trim()
  if (!trimmed) {
    return []
  }
  const parsed = JSON.parse(trimmed) as CimProcessRow | CimProcessRow[] | null
  if (!parsed) {
    return []
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed]
  return rows.flatMap((row) => {
    const pid = toInteger(row.ProcessId)
    const ppid = toInteger(row.ParentProcessId)
    if (pid === null || ppid === null) {
      return []
    }
    return [
      {
        pid,
        ppid,
        cpu: 0,
        memory: toNonNegativeInteger(row.WorkingSetSize) ?? 0
      }
    ]
  })
}

/** Parses `wmic /format:value` stanza output. Kept as a fallback for older hosts. */
export function parseWmicOutput(stdout: string): WindowsProcessWorkingSetRow[] {
  const rows: WindowsProcessWorkingSetRow[] = []
  let pid = Number.NaN
  let ppid = Number.NaN
  let ws = Number.NaN

  const flush = (): void => {
    if (!Number.isNaN(pid) && !Number.isNaN(ppid)) {
      rows.push({
        pid,
        ppid,
        cpu: 0,
        memory: Number.isFinite(ws) && ws > 0 ? ws : 0
      })
    }
    pid = Number.NaN
    ppid = Number.NaN
    ws = Number.NaN
  }

  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.length === 0) {
      flush()
      continue
    }
    const eq = line.indexOf('=')
    if (eq < 0) {
      continue
    }
    const key = line.slice(0, eq)
    const value = line.slice(eq + 1)
    if (key === 'ProcessId') {
      pid = Number.parseInt(value, 10)
    } else if (key === 'ParentProcessId') {
      ppid = Number.parseInt(value, 10)
    } else if (key === 'WorkingSetSize') {
      ws = Number.parseInt(value, 10)
    }
  }
  flush()
  return rows
}

function toInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10)
    return Number.isInteger(parsed) ? parsed : null
  }
  return null
}

function toNonNegativeInteger(value: unknown): number | null {
  const parsed = toInteger(value)
  return parsed !== null && parsed > 0 ? parsed : null
}
