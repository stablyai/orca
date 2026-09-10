import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import { AI_VAULT_AGENT_SOURCES } from '../ai-vault/session-scanner-agent-sources'
import { normalizedWslHomeDirs } from '../ai-vault/session-scanner-roots'
import { sessionCandidatesFromDiscoveries } from '../ai-vault/session-scanner-candidates'
import { discoverAiVaultSessionSources } from '../ai-vault/session-scanner-source-discovery'
import type {
  AiVaultScanOptions,
  SessionFileCandidate,
  SessionFileDiscovery
} from '../ai-vault/session-scanner-types'

/** One real directory a scan walked, and what it listed there. */
export type SessionSearchRootListing = { root: string; files: number }

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
 * Containment on path segments, not on string prefix, and on both separators:
 * discovery joins with the platform's, a configured root can arrive spelled
 * with the other, and `/a/agents-old` is not inside `/a/agents`.
 */
export function isUnderScanRoot(path: string, root: string): boolean {
  return root.length > 0 && (path.startsWith(`${root}/`) || path.startsWith(`${root}\\`))
}

/**
 * The real directories behind a scan's discoveries, with their file counts.
 *
 * Why this exists: an agent whose roots are alternates for one install reports
 * them as a single discovery whose `rootDir` is every path joined by the
 * platform's path delimiter. That string is not a directory. Health probes
 * readdir it and get ENOENT, a containment check never matches a file under it,
 * and a scan issue recorded against a real root never equals it — so the fence
 * meant to protect an unmounted tree is inert for exactly the agent most likely
 * to have one. Splitting the joined string back apart would be worse: a
 * directory may legally contain the delimiter. The constituent paths come from
 * the same source table discovery read.
 */
export function sessionSearchRootListings(
  roots: SessionSearchScanRoots,
  discoveries: readonly SessionFileDiscovery[]
): SessionSearchRootListing[] {
  const wslHomeDirs = normalizedWslHomeDirs(roots.wslHomeDirs)
  const counts = new Map<string, number>()
  for (const discovery of discoveries) {
    const constituents = constituentRoots(roots, wslHomeDirs, discovery)
    for (const root of constituents) {
      counts.set(root, counts.get(root) ?? 0)
    }
    for (const file of discovery.files) {
      const owner = owningRoot(constituents, file.path)
      if (owner !== null) {
        counts.set(owner, (counts.get(owner) ?? 0) + 1)
      }
    }
  }
  return [...counts].map(([root, files]) => ({ root, files }))
}

function constituentRoots(
  roots: SessionSearchScanRoots,
  wslHomeDirs: readonly string[],
  discovery: SessionFileDiscovery
): string[] {
  const declared = AI_VAULT_AGENT_SOURCES[discovery.agent]?.rootDirs(roots, wslHomeDirs) ?? []
  if (declared.includes(discovery.rootDir)) {
    return [discovery.rootDir]
  }
  // Either a merged discovery, whose rootDir is the joined string, or a source
  // that builds its own discoveries (OpenCode, Antigravity) and reports a real
  // directory that this table does not list.
  return declared.length > 0 ? declared : [discovery.rootDir]
}

function owningRoot(constituents: readonly string[], path: string): string | null {
  let owner: string | null = null
  for (const root of constituents) {
    if (isUnderScanRoot(path, root) && (owner === null || root.length > owner.length)) {
      owner = root
    }
  }
  return owner
}

/**
 * Roots that listed transcripts on the previous pass and list none on this one.
 *
 * The one bit of memory the retirement walk gets, and what it buys: a root that
 * blinks empty for a single pass is unverifiable rather than proven gone, so a
 * sync client swapping a directory out cannot retire a tree. It is deliberately
 * not evidence that survives the process — see the invariant block in
 * `session-search-deleted-sources.ts` for what that costs and why.
 */
export function sessionSearchEmptiedRoots(
  previous: ReadonlySet<string>,
  current: ReadonlySet<string>
): Set<string> {
  return new Set([...previous].filter((root) => !current.has(root)))
}
