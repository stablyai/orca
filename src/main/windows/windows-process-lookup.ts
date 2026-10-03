import { readWindowsProcessTableFresh } from './windows-process-table'

export type WindowsProcessLookup =
  | {
      status: 'present'
      /** Null when the process denied a query handle. */
      commandLine: string | null
      /** Null when the snapshot has no creation time for it (old addon, or denied handle). */
      startedAtMs: number | null
    }
  | { status: 'missing' }
  | { status: 'unavailable' }

/**
 * One process's command line and creation time, from a fresh process-table
 * snapshot instead of a per-PID `Get-CimInstance` in a forked `powershell.exe`.
 *
 * Fresh because callers use this for identity: a cached row can predate the
 * exit or PID reuse they are asking about. A table that cannot be read is
 * `unavailable`, never `missing` -- only a snapshot that ran and lacks the PID
 * proves absence.
 */
export async function readWindowsProcess(pid: number): Promise<WindowsProcessLookup> {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return { status: 'unavailable' }
  }
  let rows: Awaited<ReturnType<typeof readWindowsProcessTableFresh>>
  try {
    rows = await readWindowsProcessTableFresh()
  } catch {
    return { status: 'unavailable' }
  }
  const row = rows.find((candidate) => candidate.pid === pid)
  if (!row) {
    return { status: 'missing' }
  }
  return {
    status: 'present',
    commandLine: row.command || null,
    startedAtMs: row.creationTimeMs ?? null
  }
}
