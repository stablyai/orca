import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import type { SessionSearchDirectoryReader } from './session-search-directory-listings'

/** A scan root this pass could not read through, and what stopped it. */
export type SessionSearchDegradedRoot = { root: string; reason: string }

/**
 * Roots a pass could not read, derived from that pass alone.
 *
 * There is no root-health state machine any more and nothing is carried between
 * passes: "degraded" now means one of two things this pass observed, both of
 * which are readdir results.
 *
 * 1. Discovery recorded a scan issue against the root itself — a stalled WSL
 *    distro, a gate refusal, an unreadable tree.
 * 2. The retirement walk could not prove a file the index holds under that root
 *    either present or gone, because a directory between the file and the root
 *    refused to list, or because the root itself is not there.
 * 3. A root that yielded no transcripts refuses to list at all. The file walker
 *    swallows a readdir failure and returns, so without this an EACCES root and
 *    an agent that was never installed both arrive as "no files" — reporting
 *    the first as an empty index is the loss-of-contact-as-absence mistake
 *    docs/reference/ssh-execution-boundary.md forbids.
 *
 * The second is what reports a detached volume, and it needs no memory of
 * previous passes: the evidence is the index's own rows plus this pass's
 * readdir errors. A root the index holds nothing under and cannot list is
 * reported by the third; a root that is simply missing is not reported at all,
 * because that is what an agent nobody installed looks like.
 */
export function scanIssueDegradedRoots(
  roots: readonly string[],
  issues: readonly AiVaultScanIssue[]
): SessionSearchDegradedRoot[] {
  const degraded = new Map<string, string>()
  for (const issue of issues) {
    // 'notice' rows are scanner commentary; a per-file failure is not a root's.
    if (issue.kind !== 'notice' && roots.includes(issue.path)) {
      degraded.set(issue.path, issue.message)
    }
  }
  return [...degraded].map(([root, reason]) => ({ root, reason }))
}

/** One entry per root, first reason kept, so a pass reports each root once. */
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

// A missing root is not a broken one: an uninstalled agent's root answers
// exactly this, and the index holding rows under it is what the retirement
// walk reports instead.
const MISSING_ROOT = new Set(['ENOENT', 'ENOTDIR'])

/**
 * Roots that yielded no transcripts and cannot be listed either.
 *
 * Only roots a pass found empty are read: one that returned files is readable
 * by construction. The read shares the pass's listing cache, so a root the
 * retirement walk also has to ask about costs one readdir between them.
 */
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
