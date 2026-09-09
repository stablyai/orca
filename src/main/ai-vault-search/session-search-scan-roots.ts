import type { AiVaultAgent, AiVaultScanIssue } from '../../shared/ai-vault-types'
import { AI_VAULT_AGENT_SOURCES } from '../ai-vault/session-scanner-agent-sources'
import { normalizedWslHomeDirs } from '../ai-vault/session-scanner-roots'
import { sessionCandidatesFromDiscoveries } from '../ai-vault/session-scanner-candidates'
import { discoverAiVaultSessionSources } from '../ai-vault/session-scanner-source-discovery'
import type {
  AiVaultScanOptions,
  SessionFileCandidate,
  SessionFileDiscovery
} from '../ai-vault/session-scanner-types'

/**
 * Where the indexer looks. The caller resolves these so the index enumerates
 * exactly the trees the session list does; the indexer owns the bounds
 * (`limit`, `limitPerAgent`, `unlimited`) and its own cancellation, so those
 * are not the caller's to set.
 */
export type SessionSearchScanRoots = Omit<
  AiVaultScanOptions,
  'signal' | 'limit' | 'unlimited' | 'limitPerAgent' | 'scopePaths'
>

export type SessionSearchDiscovery = {
  /** Newest first, Codex hardlink aliases collapsed, exactly as a list scan sees them. */
  candidates: SessionFileCandidate[]
  discoveries: SessionFileDiscovery[]
  issues: AiVaultScanIssue[]
}

/**
 * The discovery half of a list scan, without the parse. `limitPerAgent` is the
 * sidebar's own recency rule (`SessionNewestFiles` keeps the newest N per root);
 * passing Infinity is what makes a sweep whole.
 */
export async function discoverSessionSearchCandidates(
  roots: SessionSearchScanRoots,
  args: { limitPerAgent: number; signal?: AbortSignal }
): Promise<SessionSearchDiscovery> {
  const issues: AiVaultScanIssue[] = []
  const options: AiVaultScanOptions = { ...roots, signal: args.signal }
  const discoveries = await discoverAiVaultSessionSources({
    options,
    limitPerAgent: args.limitPerAgent,
    issues
  })
  const candidates = await sessionCandidatesFromDiscoveries(discoveries, options)
  return { candidates, discoveries, issues }
}

/**
 * Which agent owns a path, read off the same source table discovery walks.
 *
 * Why not a mapping of its own: `deletable` and `discoverable` already share
 * that table on purpose, and a second spelling of "this directory belongs to
 * Codex" would drift from it the first time a root moves. Longest root wins, so
 * a nested root is not shadowed by its parent.
 */
export function sessionSearchAgentForPath(
  roots: SessionSearchScanRoots,
  path: string
): AiVaultAgent | null {
  const wslHomeDirs = normalizedWslHomeDirs(roots.wslHomeDirs)
  let owner: { agent: AiVaultAgent; root: string } | null = null
  for (const [agent, source] of Object.entries(AI_VAULT_AGENT_SOURCES)) {
    for (const root of source?.rootDirs(roots, wslHomeDirs) ?? []) {
      if (!underRoot(path, root) || (owner && owner.root.length >= root.length)) {
        continue
      }
      owner = { agent: agent as AiVaultAgent, root }
    }
  }
  return owner?.agent ?? null
}

function underRoot(path: string, root: string): boolean {
  return root.length > 0 && (path.startsWith(`${root}/`) || path.startsWith(`${root}\\`))
}
