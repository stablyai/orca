import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
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
