import { delimiter } from 'node:path'
import type { AiVaultAgent, AiVaultScanIssue } from '../../shared/ai-vault-types'
import { discoverFiles } from './session-scanner-discovery'
import { opencodeDiscoveries } from './session-scanner-opencode-sources'
import { antigravityDiscoveries } from './session-scanner-antigravity-sources'
import { AI_VAULT_AGENT_SOURCES, type AiVaultAgentSource } from './session-scanner-agent-sources'
import { normalizedWslHomeDirs } from './session-scanner-roots'
import type { AiVaultScanOptions, SessionFileDiscovery } from './session-scanner-types'

export { DEFAULT_CODEX_HOME_DIR } from './session-scanner-agent-sources'

export async function discoverAiVaultSessionSources(args: {
  options: AiVaultScanOptions
  limitPerAgent: number
  issues: AiVaultScanIssue[]
}): Promise<SessionFileDiscovery[]> {
  const { options, limitPerAgent, issues } = args
  const wslHomeDirs = normalizedWslHomeDirs(options.wslHomeDirs)

  return Promise.all([
    // Why: OpenCode 1.17.x migrated sessions from per-session JSON files to a
    // SQLite DB. discoverOpenCodeSessions runs both the file scanner (legacy)
    // and the SQLite scanner (1.17.x); dedup by sessionId happens inside.
    ...opencodeDiscoveries(options, wslHomeDirs, limitPerAgent, issues),
    ...antigravityDiscoveries(options, wslHomeDirs, limitPerAgent, issues),
    ...Object.entries(AI_VAULT_AGENT_SOURCES).flatMap(([agent, source]) =>
      source
        ? agentDiscoveries(
            agent as AiVaultAgent,
            source,
            options,
            wslHomeDirs,
            limitPerAgent,
            issues
          )
        : []
    )
  ])
}

function agentDiscoveries(
  agent: AiVaultAgent,
  source: AiVaultAgentSource,
  options: AiVaultScanOptions,
  wslHomeDirs: readonly string[],
  limit: number,
  issues: AiVaultScanIssue[]
): Promise<SessionFileDiscovery>[] {
  const rootDirs = source.rootDirs(options, wslHomeDirs)
  const discover = (rootDir: string): Promise<SessionFileDiscovery> =>
    discoverFiles({
      rootDir,
      limit,
      agent,
      issues,
      extensions: [...source.extensions],
      filePredicate: source.filePredicate,
      contentDependencyPath: source.contentDependencyPath,
      directoryPredicate: source.directoryPredicate
    })
  return source.mergeRootDiscoveries
    ? [mergedDiscovery(agent, rootDirs, limit, discover)]
    : rootDirs.map(discover)
}

// Alternate roots for one install: the limit spans them, so they collapse into
// a single discovery rather than each claiming a full slice of it.
async function mergedDiscovery(
  agent: AiVaultAgent,
  rootDirs: readonly string[],
  limit: number,
  discover: (rootDir: string) => Promise<SessionFileDiscovery>
): Promise<SessionFileDiscovery> {
  const discoveries = await Promise.all(rootDirs.map(discover))
  const files = discoveries
    .flatMap((discovery) => discovery.files)
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, limit)
  return { agent, rootDir: rootDirs.join(delimiter), files }
}
