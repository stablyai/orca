import type { AiVaultAgent } from '../../../../../shared/ai-vault/contracts/ai-vault-types'
import type {
  AiVaultScanOptions,
  SessionFileCandidate,
  SessionFileDiscovery
} from '../../../session-scanner-types'
import { scopeOnlyScan, scopeWalksAgentFiles } from '../../../session-scope-cwd'

type SqliteList = (args: {
  scopePaths?: readonly string[]
  reportsProgress: boolean
}) => Promise<SessionFileCandidate[]>

/** Recency rows plus in-scope rows from one SQLite store; a scope-only scan skips the recency rows it would only drop. */
export async function sqliteDiscoveryFiles(
  agent: AiVaultAgent,
  options: AiVaultScanOptions,
  list: SqliteList
): Promise<Pick<SessionFileDiscovery, 'files' | 'scopeFiles'>> {
  const scopeOnly = scopeOnlyScan(options)
  const files = (scopePaths?: readonly string[]) =>
    list({ scopePaths, reportsProgress: scopeOnly }).then((candidates) =>
      candidates.map((candidate) => candidate.file)
    )
  const [recent, scopeFiles] = await Promise.all([
    scopeOnly ? [] : files(),
    scopeWalksAgentFiles(agent, options.scopePaths) ? files(options.scopePaths) : undefined
  ])
  return { files: recent, ...(scopeFiles ? { scopeFiles } : {}) }
}
