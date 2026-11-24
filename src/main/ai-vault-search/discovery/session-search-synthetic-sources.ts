import type { AiVaultScanIssue } from '../../../shared/ai-vault/contracts/ai-vault-types'
import { splitOpenCodeSqliteCandidate } from '../../../shared/agent-session/lifecycle/provider-handles/opencode-sqlite-session-path'
import type { SessionFileCandidate } from '../../ai-vault/session-scanner-types'

/** A session inside a shared container rather than a standalone transcript file. */
export type SessionSearchSyntheticSource = { container: string; id: string }

export function splitSyntheticSessionSource(path: string): SessionSearchSyntheticSource | null {
  const sqlite = splitOpenCodeSqliteCandidate(path, 'any')
  return sqlite ? { container: sqlite.dbPath, id: sqlite.sessionId } : null
}

/**
 * Call only with an exhaustive sweep: limited discovery cannot prove deletions.
 * Exclude failed containers; empty results require explicit enumeration evidence.
 */
export function sessionSearchEnumeratedContainers(
  candidates: readonly SessionFileCandidate[],
  issues: readonly AiVaultScanIssue[],
  completeContainers: readonly string[] = []
): Map<string, Set<string>> {
  const containers = new Map(completeContainers.map((path) => [path, new Set<string>()]))
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
