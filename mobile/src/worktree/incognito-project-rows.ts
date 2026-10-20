// Why: phones have no incognito unlock, so every reply that lists projects or workspaces drops
// incognito ones at the reader, before any cache, card or picker sees a name.

function hasTrueMember(row: unknown, key: string): boolean {
  return (
    typeof row === 'object' &&
    row !== null &&
    Object.getOwnPropertyDescriptor(row, key)?.value === true
  )
}

/** A `repo.list` row the host marks incognito (`Repo.incognito`). */
export function isIncognitoRepoRow(row: unknown): boolean {
  return hasTrueMember(row, 'incognito')
}

/** A `worktree.ps` row whose project the host marks incognito (`repoIncognito`). */
export function isIncognitoWorktreeRow(row: unknown): boolean {
  return hasTrueMember(row, 'repoIncognito')
}

export function withoutIncognitoRepoRows<T>(rows: readonly T[]): T[] {
  return rows.filter((row) => !isIncognitoRepoRow(row))
}

export function withoutIncognitoWorktreeRows<T>(rows: readonly T[]): T[] {
  return rows.filter((row) => !isIncognitoWorktreeRow(row))
}
