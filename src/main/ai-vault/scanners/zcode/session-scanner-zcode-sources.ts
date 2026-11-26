import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AiVaultScanIssue } from '../../../../shared/ai-vault/contracts/ai-vault-types'
import type { AiVaultScanOptions, SessionFileDiscovery } from '../../session-scanner-types'
import { discoverStandaloneSqliteSessions } from '../opencode/sqlite/session-scanner-opencode-sqlite-discovery'

export function zcodeDiscoveries(
  options: AiVaultScanOptions,
  wslHomeDirs: readonly string[],
  limit: number,
  issues: AiVaultScanIssue[]
): Promise<SessionFileDiscovery>[] {
  const paths = options.zcodeDbPath
    ? [options.zcodeDbPath]
    : [homedir(), ...wslHomeDirs].map((home) => join(home, '.zcode', 'cli', 'db', 'db.sqlite'))
  return paths.map((dbPath) =>
    discoverStandaloneSqliteSessions('zcode', dbPath, options, limit, issues)
  )
}
