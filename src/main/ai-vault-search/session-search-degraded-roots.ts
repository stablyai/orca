import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import type { SessionSearchDirectoryReader } from './session-search-directory-listings'

export type SessionSearchDegradedRoot = { root: string; reason: string }

/** Report this pass’s root-level scan failures; per-file failures do not establish root failure. */
export function scanIssueDegradedRoots(
  roots: readonly string[],
  issues: readonly AiVaultScanIssue[]
): SessionSearchDegradedRoot[] {
  const degraded = new Map<string, string>()
  for (const issue of issues) {
    if (issue.kind !== 'notice' && roots.includes(issue.path)) {
      degraded.set(issue.path, issue.message)
    }
  }
  return [...degraded].map(([root, reason]) => ({ root, reason }))
}

export function mergeDegradedRoots(
  ...groups: readonly (readonly SessionSearchDegradedRoot[])[]
): SessionSearchDegradedRoot[] {
  const merged = new Map<string, string>()
  for (const group of groups) {
    for (const degraded of group) {
      if (!merged.has(degraded.root)) {
        merged.set(degraded.root, degraded.reason)
      }
    }
  }
  return [...merged].map(([root, reason]) => ({ root, reason }))
}

// Missing roots can mean an uninstalled agent; retirement reports them only when indexed rows remain.
const MISSING_ROOT = new Set(['ENOENT', 'ENOTDIR'])

/** Probe roots that yielded no transcripts, sharing this pass’s cached directory listings. */
export async function unreadableRoots(
  roots: readonly string[],
  listings: SessionSearchDirectoryReader,
  signal?: AbortSignal
): Promise<SessionSearchDegradedRoot[]> {
  const degraded: SessionSearchDegradedRoot[] = []
  for (const root of roots) {
    if (signal?.aborted) {
      break
    }
    const listing = await listings.namesIn(root, signal)
    if (!listing.listed && !(listing.code !== null && MISSING_ROOT.has(listing.code))) {
      degraded.push({ root, reason: listing.message })
    }
  }
  return degraded
}
