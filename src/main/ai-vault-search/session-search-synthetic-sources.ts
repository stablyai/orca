import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import { splitOpenCodeSqliteCandidate } from '../ai-vault/session-scanner-opencode-sqlite-paths'
import type { SessionFileCandidate } from '../ai-vault/session-scanner-types'

/** A session inside a shared container rather than a standalone transcript file. */
export type SessionSearchSyntheticSource = { container: string; id: string }

export function splitSyntheticSessionSource(path: string): SessionSearchSyntheticSource | null {
  const sqlite = splitOpenCodeSqliteCandidate(path) ?? splitOpenCodeSqliteCandidate(path, 'zcode')
  return sqlite ? { container: sqlite.dbPath, id: sqlite.sessionId } : null
}

/**
 * Call only with an exhaustive sweep: limited discovery cannot prove deletions.
 * Exclude failed containers; empty results may mean an unrecognized schema.
 */
export function sessionSearchEnumeratedContainers(
  candidates: readonly SessionFileCandidate[],
  issues: readonly AiVaultScanIssue[]
): Map<string, Set<string>> {
  const containers = new Map<string, Set<string>>()
  for (const candidate of candidates) {
    const synthetic = splitSyntheticSessionSource(candidate.file.path)
    if (!synthetic) {
      continue
    }
    const ids = containers.get(synthetic.container) ?? new Set<string>()
    ids.add(synthetic.id)
    containers.set(synthetic.container, ids)
  }
  for (const issue of issues) {
    if (issue.kind !== 'notice') {
      containers.delete(issue.path)
    }
  }
  return containers
}
