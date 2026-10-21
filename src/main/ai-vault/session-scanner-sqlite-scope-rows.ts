import { createAiVaultScopeCwdMatcher } from '../../shared/ai-vault-scope-cwd-match'

/** Foreign databases need canonical descendant matching before output admission. */
export function scopedSessionRows<Row extends { directory?: unknown }>(
  rows: Iterable<Row>,
  scopePaths: readonly string[],
  limit: number,
  dbPath: string
): Row[] {
  const inScope = createAiVaultScopeCwdMatcher(scopePaths)
  const matching: Row[] = []
  for (const row of rows) {
    if (
      !('directory' in row) ||
      inScope(typeof row.directory === 'string' ? row.directory : null, dbPath)
    ) {
      matching.push(row)
      if (matching.length >= limit) {
        break
      }
    }
  }
  return matching
}
