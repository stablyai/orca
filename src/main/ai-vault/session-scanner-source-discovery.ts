import { delimiter } from 'node:path'
import { realpath } from 'node:fs/promises'
import type { AiVaultAgent, AiVaultScanIssue } from '../../shared/ai-vault-types'
import { discoverFiles } from './session-scanner-discovery'
import { opencodeDiscoveries } from './session-scanner-opencode-sources'
import { zcodeDiscoveries } from './session-scanner-zcode-sources'
import { antigravityDiscoveries } from './session-scanner-antigravity-sources'
import { AI_VAULT_AGENT_SOURCES, type AiVaultAgentSource } from './session-scanner-agent-sources'
import { normalizedWslHomeDirs } from './session-scanner-roots'
import { configureOpenCodeWslReaders } from './session-scanner-opencode-wsl-client'
import type { AiVaultScanOptions, SessionFileDiscovery } from './session-scanner-types'

export { DEFAULT_CODEX_HOME_DIR } from './session-scanner-agent-sources'

export async function discoverAiVaultSessionSources(args: {
  options: AiVaultScanOptions
  limitPerAgent: number
  issues: AiVaultScanIssue[]
}): Promise<SessionFileDiscovery[]> {
  const { options, limitPerAgent, issues } = args
  if (options.wslOpenCodeReaders) {
    configureOpenCodeWslReaders(options.wslOpenCodeReaders)
  }
  const wslHomeDirs = normalizedWslHomeDirs(options.wslHomeDirs)

  // The Cursor chat-meta scan scope is owned by scanAiVaultSessions: it has to
  // span parse as well, and finalize runs after this returns.
  return Promise.all([
    // Why: OpenCode 1.17.x migrated sessions from per-session JSON files to a
    // SQLite DB. discoverOpenCodeSessions runs both the file scanner (legacy)
    // and the SQLite scanner (1.17.x); dedup by sessionId happens inside.
    ...opencodeDiscoveries(options, wslHomeDirs, limitPerAgent, issues),
    ...zcodeDiscoveries(options, wslHomeDirs, limitPerAgent, issues),
    ...antigravityDiscoveries(options, wslHomeDirs, limitPerAgent, issues),
    ...Object.entries(AI_VAULT_AGENT_SOURCES).flatMap(([agent, source]) =>
      source
        ? [
            agentDiscoveries(
              agent as AiVaultAgent,
              source,
              options,
              wslHomeDirs,
              limitPerAgent,
              issues
            )
          ]
        : []
    )
  ]).then((discoveries) => discoveries.flat())
}

async function agentDiscoveries(
  agent: AiVaultAgent,
  source: AiVaultAgentSource,
  options: AiVaultScanOptions,
  wslHomeDirs: readonly string[],
  limit: number,
  issues: AiVaultScanIssue[]
): Promise<SessionFileDiscovery[]> {
  const configuredRoots = source.rootDirs(options, wslHomeDirs)
  const rootDirs = source.walkLinkedRootsOnce
    ? await uniqueLinkedRoots(configuredRoots)
    : configuredRoots
  const discover = (rootDir: string): Promise<SessionFileDiscovery> =>
    discoverFiles({
      rootDir,
      limit,
      agent,
      issues,
      extensions: [...source.extensions],
      filePredicate: source.filePredicate,
      contentDependencyPath: source.contentDependencyPath,
      directoryPredicate: source.directoryPredicate,
      signal: options.signal
    })
  return source.mergeRootDiscoveries
    ? [await mergedDiscovery(agent, rootDirs, limit, discover)]
    : Promise.all(rootDirs.map(discover))
}

// A CLAUDE_CONFIG_DIR naming an Orca account home (whose projects is a link) or
// a user alias of ~/.claude gives one history several spellings; walk it once
// under the first. Lookup and deletion still accept every spelling.
async function uniqueLinkedRoots(roots: readonly string[]): Promise<string[]> {
  const canonical = await Promise.all(roots.map(localRealpath))
  const seen = new Set<string>()
  return roots.filter((_, index) => {
    const key = canonical[index]
    if (key === null) {
      return true
    }
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
}

const isUncPath = (path: string): boolean => /^[\\/]{2}/.test(path)

// WSL and network (UNC) roots are never resolved here: they keep their gated
// readers. Unresolvable roots keep their existing discovery and error path.
async function localRealpath(root: string): Promise<string | null> {
  if (isUncPath(root)) {
    return null
  }
  const resolved = await realpath(root).catch(() => null)
  return resolved !== null && !isUncPath(resolved) ? resolved : null
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
