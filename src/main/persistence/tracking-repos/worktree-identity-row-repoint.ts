type WorktreeNamingRow = { worktreeId: string }

/** Null means unchanged; callers assign concrete fields without widening their row types. */
export function repointRowRecord<Row extends WorktreeNamingRow>(
  record: Record<string, Row> | undefined,
  oldWorktreeId: string,
  newWorktreeId: string
): Record<string, Row> | null {
  if (!record) {
    return null
  }
  let changed = false
  const next: Record<string, Row> = { ...record }
  for (const [key, row] of Object.entries(record)) {
    if (row?.worktreeId !== oldWorktreeId) {
      continue
    }
    next[key] = { ...row, worktreeId: newWorktreeId }
    changed = true
  }
  return changed ? next : null
}

export function repointRowArrays<Row extends WorktreeNamingRow>(
  record: Record<string, Row[]> | undefined,
  oldWorktreeId: string,
  newWorktreeId: string
): Record<string, Row[]> | null {
  if (!record) {
    return null
  }
  let changed = false
  const next: Record<string, Row[]> = { ...record }
  for (const [key, rows] of Object.entries(record)) {
    if (!Array.isArray(rows) || !rows.some((row) => row?.worktreeId === oldWorktreeId)) {
      continue
    }
    next[key] = rows.map((row) =>
      row?.worktreeId === oldWorktreeId ? { ...row, worktreeId: newWorktreeId } : row
    )
    changed = true
  }
  return changed ? next : null
}
