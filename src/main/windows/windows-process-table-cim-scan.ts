import { runProcess } from '../../shared/child-process/run-process'
import { windowsPowerShellPath } from '../../shared/child-process/windows-system-binary'
import type { WindowsProcessRow } from './windows-process-table'

/**
 * The `Get-CimInstance Win32_Process` scan, kept only for hosts where the
 * native Toolhelp32 binding is not installed.
 *
 * Why this still exists after #15749 retired it: the relay bundle is deployed to
 * SSH hosts that only ever receive `node-pty` and `@parcel/watcher`, so
 * `@vscode/windows-process-tree` is absent there and every native read rejects.
 * Callers read that as "no evidence", so a pane keeps whatever name node-pty
 * reported -- the shell, usually -- instead of the agent running under it, for
 * the life of the relay process. This restores the v1.4.188 answer on exactly
 * those hosts; the local app ships the addon and never reaches this path.
 *
 * Measured on a Windows 11 SSH host with 1486 processes: 1.36s and 4.8MiB of
 * JSON per scan, against the 3s / 8MiB limits below. Both limits match the
 * pre-#15749 reader, so this is parity, but the headroom is thinner than the
 * 706ms figure in docs/reference/windows-process-enumeration.md suggests.
 */

const WINDOWS_CIM_QUERY_TIMEOUT_MS = 3_000
const WINDOWS_CIM_MAX_OUTPUT_BYTES = 8 * 1024 * 1024

// Why JSON and not the `Key=Value` list form: CommandLine can itself contain
// CR/LF, so an argument could otherwise masquerade as another row's field.
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
    return [{ pid, ppid, name, command: fieldAsString(row.CommandLine) || name }]
  })
}

/**
 * Read the whole process table through PowerShell.
 *
 * Throws rather than returning `[]` on any failure: an empty table is a claim
 * that nothing is running, and callers act on that by declaring a tree dead.
 */
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
