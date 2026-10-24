type WorktreeNamingRow = { worktreeId: string }

/**
 * A session map keyed by pane, tab or environment whose VALUE names the worktree it belongs to.
 * Returns the repointed record, or null when no row named the old id — so the caller assigns to
 * the concrete field and the row type is never widened.
 */
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

/** Same, but each value is an array of such rows. */
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
