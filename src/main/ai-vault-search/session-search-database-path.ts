import { join } from 'node:path'

/**
 * Where one host keeps its index.
 *
 * Beside the scanner's parse cache (`<dataRoot>/ai-vault/`), because the two are
 * the same kind of thing: a disposable derivative of the transcripts this host
 * can read, scoped to this host's data root. One file per host, never shared —
 * a second process writing the same file is the rebuild race PR 2 recorded.
 */
export function sessionSearchDatabasePath(dataRoot: string): string {
  return join(dataRoot, 'ai-vault', 'session-search.sqlite')
}
