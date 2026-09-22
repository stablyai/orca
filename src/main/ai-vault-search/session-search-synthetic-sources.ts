import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import { splitOpenCodeSqliteCandidate } from '../ai-vault/session-scanner-opencode-sqlite-paths'
import type { SessionFileCandidate } from '../ai-vault/session-scanner-types'

/**
 * A row whose path names a container and an entry inside it rather than a file
 * of its own. OpenCode's SQLite sessions are the one shape today
 * (`<opencode.db>#<sessionId>`), which is why this reads through that source's
 * own splitter rather than reinventing the encoding.
 */
export type SessionSearchSyntheticSource = { container: string; id: string }

export function splitSyntheticSessionSource(path: string): SessionSearchSyntheticSource | null {
  const openCode = splitOpenCodeSqliteCandidate(path)
  return openCode ? { container: openCode.dbPath, id: openCode.sessionId } : null
}

/**
 * Which containers a pass enumerated in full, and every id each of them held.
 *
 * This is the synthetic equivalent of a directory listing, and it has to meet
 * the same bar before the retirement walk may prove anything from it:
 *
 * - **Exhaustive.** Only a sweep enumerates without a per-agent limit. A cycle
 *   asks for the newest N, so an id it did not return may simply be the N+1th.
 *   Callers that are not a census do not build this at all.
 * - **Successful.** A container a scan issue names could not be read, and a
 *   read that failed returns no ids rather than an error the walk can see. A
 *   named container is left out, so its rows stay unverifiable.
 * - **Non-empty.** A container that returned nothing is not evidence that it
 *   holds nothing: a database whose schema this scanner no longer recognises
 *   returns an empty list with no error at all, and believing it would retire
 *   every session in one pass. The cost is one stale row per container whose
 *   last entry the user deletes, until the container gains an entry or goes.
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
