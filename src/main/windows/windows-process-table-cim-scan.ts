import { runProcess } from '@orca/process-host'
import { windowsPowerShellPath } from '@orca/process-host/windows-system-binary'
import type { WindowsProcessRow } from './windows-process-table'

/** CIM fallback for hosts without a usable native binding, including older relay deployments. Windows 11/1486-process measurement: 1.36s and 4.8MiB, bounded at 3s/8MiB. */

const WINDOWS_CIM_QUERY_TIMEOUT_MS = 3_000
const WINDOWS_CIM_MAX_OUTPUT_BYTES = 8 * 1024 * 1024

// CommandLine may contain CR/LF; JSON prevents arguments from masquerading as list-form row fields.
const POWERSHELL_PROCESS_QUERY =
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ' +
  'Get-CimInstance -ClassName Win32_Process -Property CommandLine,Name,ParentProcessId,ProcessId | ' +
  'Select-Object CommandLine,Name,ParentProcessId,ProcessId | ' +
  'ConvertTo-Json -Compress'

type CimProcessRow = {
  CommandLine?: unknown
  Name?: unknown
  ParentProcessId?: unknown
  ProcessId?: unknown
}

function fieldAsString(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  return value === null || value === undefined ? '' : String(value)
}

function fieldAsNumber(value: unknown): number {
  if (typeof value === 'number') {
    return value
  }
  return typeof value === 'string' ? Number.parseInt(value, 10) : Number.NaN
}

export function parseWindowsCimProcessRows(stdout: string): WindowsProcessRow[] | null {
  const trimmed = stdout.trim()
  if (!trimmed) {
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  const items = Array.isArray(parsed) ? parsed : [parsed]
  return items.flatMap((item) => {
    if (!item || typeof item !== 'object') {
      return []
    }
    const row = item as CimProcessRow
    const pid = fieldAsNumber(row.ProcessId)
    const ppid = fieldAsNumber(row.ParentProcessId)
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) {
      return []
    }
    const name = fieldAsString(row.Name)
    // Omit unused working sets to limit an already expensive scan.
    return [{ pid, ppid, name, command: fieldAsString(row.CommandLine) || name }]
  })
}

/** Reject failures: an empty table would falsely prove process trees dead. */
export async function readWindowsProcessRowsWithCim(): Promise<WindowsProcessRow[]> {
  const result = await runProcess({
    program: windowsPowerShellPath(),
    args: ['-NoProfile', '-NonInteractive', '-Command', POWERSHELL_PROCESS_QUERY],
    timeoutMs: WINDOWS_CIM_QUERY_TIMEOUT_MS,
    maxOutputBytes: WINDOWS_CIM_MAX_OUTPUT_BYTES
  })
  if (result.timedOut || result.code !== 0) {
    throw new Error(
      `windows process table CIM scan failed (code=${result.code} timedOut=${result.timedOut})`
    )
  }
  const rows = parseWindowsCimProcessRows(result.stdout)
  if (!rows || rows.length === 0) {
    throw new Error('windows process table CIM scan returned no rows')
  }
  return rows
}
