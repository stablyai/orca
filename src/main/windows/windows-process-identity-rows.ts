import type { WindowsProcessIdentityRow, WindowsProcessRow } from './windows-process-table'

export function toIdentityRow(row: {
  pid: number
  ppid: number
  name: string
  creationTimeMs?: number
}): WindowsProcessIdentityRow {
  return {
    pid: row.pid,
    ppid: row.ppid,
    name: row.name,
    ...(typeof row.creationTimeMs === 'number' ? { creationTimeMs: row.creationTimeMs } : {})
  }
}

/** One identity projection per detailed snapshot, so panes reading it share the array and its index. */
const identityProjections = new WeakMap<readonly WindowsProcessRow[], WindowsProcessIdentityRow[]>()

export function projectIdentityRows(rows: WindowsProcessRow[]): WindowsProcessIdentityRow[] {
  let identity = identityProjections.get(rows)
  if (!identity) {
    identity = rows.map(toIdentityRow)
    identityProjections.set(rows, identity)
  }
  return identity
}
