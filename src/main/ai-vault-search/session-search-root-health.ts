import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import { wslGatedReaddir } from '../native-chat/wsl-transcript-fs-access'
import type { SessionSearchRootListing } from './session-search-scan-roots'

/** A scan root the index could not read, and what stopped it. */
export type SessionSearchDegradedRoot = { root: string; reason: string }

/** What the last full sweeps saw of one root, carried between passes. */
export type SessionSearchRootState = {
  /** Transcripts it listed when it was last seen holding any. */
  lastHealthyCount: number
  /** Consecutive full sweeps that listed it, successfully, as empty. */
  emptySweeps: number
}

export type SessionSearchRootHealth = {
  degraded: SessionSearchDegradedRoot[]
  /** Carried forward; only a census writes it. */
  states: Map<string, SessionSearchRootState>
}

// Why the indexer probes at all: the file walker swallows a readdir failure and
// returns, so an EACCES root and an agent that was never installed both arrive
// as "no files". Reporting the first as an empty index would be the
// loss-of-contact-as-absence mistake docs/reference/ssh-execution-boundary.md
// forbids, so an empty root is re-checked and only ENOENT counts as absent.
const ABSENT_ROOT = new Set(['ENOENT', 'ENOTDIR'])

/** How many consecutive listable-but-empty sweeps mean the user emptied it. */
const EMPTY_SWEEPS_BEFORE_TRUSTED = 2

/**
 * Classifies the roots a pass walked. Only roots that listed nothing are
 * probed: one that returned files is readable by construction.
 *
 * The rule an empty root is judged by, and why it takes two sweeps:
 *
 * - Cannot be listed at all: degraded, keeping its last healthy count. An
 *   unmounted SSH home or a detached drive is not an emptied one, and its
 *   transcripts must not be retired on an ENOENT they all answer at once.
 * - Lists successfully but empty, having held transcripts before: degraded for
 *   now. This is what a freshly unmounted volume also looks like, and one sweep
 *   cannot tell the two apart.
 * - Lists successfully but empty on two consecutive full sweeps: the user
 *   really did delete them. Degraded clears and the rows retire. Without this
 *   the alarm never releases, so a legitimately emptied root pins the whole
 *   index at `degraded` for the life of the process.
 *
 * Only a full sweep counts toward that tally. A recent-window cycle can see a
 * root that went to zero, but it is not a census and must not conclude one.
 */
export async function sessionSearchRootHealth(args: {
  listings: readonly SessionSearchRootListing[]
  issues: readonly AiVaultScanIssue[]
  previous: ReadonlyMap<string, SessionSearchRootState>
  /** True for a full sweep, whose observation is allowed to move the tally. */
  census: boolean
  signal?: AbortSignal
}): Promise<SessionSearchRootHealth> {
  const degraded = new Map<string, string>()
  const states = new Map(args.previous)
  for (const issue of args.issues) {
    if (issue.kind !== 'notice' && args.listings.some((one) => one.root === issue.path)) {
      degraded.set(issue.path, issue.message)
    }
  }
  for (const listing of args.listings) {
    const previous = args.previous.get(listing.root) ?? { lastHealthyCount: 0, emptySweeps: 0 }
    if (listing.files > 0) {
      states.set(listing.root, { lastHealthyCount: listing.files, emptySweeps: 0 })
      continue
    }
    if (degraded.has(listing.root) || args.signal?.aborted) {
      continue
    }
    const unreadable = await unreadableRootReason(listing.root, args.signal)
    if (unreadable !== null) {
      degraded.set(listing.root, unreadable)
      continue
    }
    // Listable and empty. The tally only advances on a census, so a cycle reads
    // the sweep's count without ever concluding a root was emptied.
    const emptySweeps = previous.emptySweeps + (args.census ? 1 : 0)
    if (args.census) {
      states.set(listing.root, { ...previous, emptySweeps })
    }
    if (previous.lastHealthyCount > 0 && emptySweeps < EMPTY_SWEEPS_BEFORE_TRUSTED) {
      degraded.set(
        listing.root,
        `Listed no transcripts where it listed ${previous.lastHealthyCount} before.`
      )
      continue
    }
    if (args.census && emptySweeps >= EMPTY_SWEEPS_BEFORE_TRUSTED) {
      // Believed: stop carrying a healthy count that is no longer true.
      states.set(listing.root, { lastHealthyCount: 0, emptySweeps })
    }
  }
  return { degraded: [...degraded].map(([root, reason]) => ({ root, reason })), states }
}

async function unreadableRootReason(root: string, signal?: AbortSignal): Promise<string | null> {
  try {
    await wslGatedReaddir(root, 'scan', signal)
    return null
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        ? error.code
        : null
    if (code !== null && ABSENT_ROOT.has(code)) {
      return null
    }
    return error instanceof Error ? error.message : String(error)
  }
}

/** True when a path lives under a root this pass could not trust. */
export function underDegradedRoot(
  path: string,
  degradedRoots: readonly SessionSearchDegradedRoot[]
): boolean {
  // Both separators: discovery joins with the platform's, and a root can arrive
  // from a config value written with the other one.
  return degradedRoots.some(
    (degraded) =>
      path === degraded.root ||
      path.startsWith(`${degraded.root}/`) ||
      path.startsWith(`${degraded.root}\\`)
  )
}
