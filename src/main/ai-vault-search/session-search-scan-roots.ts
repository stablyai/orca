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

export type SessionSearchRootListing = { root: string; files: number }

/** Use session-list roots; the indexer owns scan limits, scope and cancellation. */
export type SessionSearchScanRoots = Omit<
  AiVaultScanOptions,
  'signal' | 'limit' | 'unlimited' | 'limitPerAgent' | 'scopePaths'
>

export type SessionSearchDiscovery = {
  /** Newest first with Codex hardlink aliases collapsed, matching session-list discovery. */
  candidates: SessionFileCandidate[]
  discoveries: SessionFileDiscovery[]
  issues: AiVaultScanIssue[]
}

/** Infinity sweeps every candidate; finite limits use the sidebar’s newest-per-root rule. */
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

/** Accept either path separator and require a segment boundary to exclude sibling prefixes. */
export function isUnderScanRoot(path: string, root: string): boolean {
  return root.length > 0 && (path.startsWith(`${root}/`) || path.startsWith(`${root}\\`))
}

/** Resolve merged roots from the source table; path delimiters may occur inside directory names. */
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
  // Merged discoveries use declared roots; custom sources without declarations report real directories.
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

/** Newly empty roots receive one pass of grace; this observation does not survive a restart. */
export function sessionSearchEmptiedRoots(
  previous: ReadonlySet<string>,
  current: ReadonlySet<string>
): Set<string> {
  return new Set([...previous].filter((root) => !current.has(root)))
}

/** Compare normalized fields so object/key/list reordering alone cannot trigger a rebuild. */
export function sameSessionSearchRoots(
  a: SessionSearchScanRoots,
  b: SessionSearchScanRoots
): boolean {
  const left = comparableRootFields(a)
  const right = comparableRootFields(b)
  return left.length === right.length && left.every((field, index) => field === right[index])
}

function comparableRootFields(roots: SessionSearchScanRoots): string[] {
  const { wslOpenCodeReaders, ...pathRoots } = roots
  return Object.entries(pathRoots)
    .filter(([, value]) => value !== undefined)
    .map(
      ([key, value]) => `${key}=${JSON.stringify(Array.isArray(value) ? [...value].sort() : value)}`
    )
    .concat(
      (wslOpenCodeReaders ?? []).map(
        (reader) =>
          `wslOpenCodeReaders=${JSON.stringify([
            reader.distro.toLowerCase(),
            reader.executable,
            reader.readerPath,
            reader.error
          ])}`
      )
    )
    .sort()
}
