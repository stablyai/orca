import { isolatedScanRoots } from './session-scanner-test-fixtures'
import { writeDocumentAgentFixtures } from './session-scanner-document-agent-fixtures'
import { writeLogAgentFixtures } from './session-scanner-log-agent-fixtures'

// Why this is shared rather than inline in one test: it is the only place that
// writes one transcript in every supported agent's own format. A scan test and
// the search index's capture guard both need exactly that, and a second copy
// would drift the moment an agent's layout changed.

export type EveryAgentVault = {
  roots: ReturnType<typeof isolatedScanRoots>
  /** Ids the caller asserts resume commands against. */
  antigravitySessionId: string
  /** OMP and Prime Agent resume by absolute transcript path, not by id. */
  ompSessionFile: string
  primeAgentSessionFile: string
}

/**
 * Write one session per supported agent under `root`, each in that agent's own
 * on-disk layout. OpenCode gets its legacy JSON layout here; its SQLite layout
 * has its own builder, because it needs a database rather than a tree.
 * @param root - An empty temporary directory to build the vault in.
 * @returns The scan roots for `root`, and the ids a caller asserts against.
 */
export async function writeEveryAgentVault(root: string): Promise<EveryAgentVault> {
  const roots = isolatedScanRoots(root)
  const antigravitySessionId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  const { ompSessionFile, primeAgentSessionFile } = await writeLogAgentFixtures(roots)
  await writeDocumentAgentFixtures(root, roots, antigravitySessionId)
  return { roots, antigravitySessionId, ompSessionFile, primeAgentSessionFile }
}
